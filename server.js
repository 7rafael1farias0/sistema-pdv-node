require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const SECRET = 'chave_super_secreta_pdv';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:senha@localhost:5432/pdv',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ==========================================
// ☁️ INICIALIZAÇÃO DO BANCO
// ==========================================
const initDB = async () => { 
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, usuario VARCHAR(255) UNIQUE, senha VARCHAR(255), cargo VARCHAR(50))`);
        await pool.query(`CREATE TABLE IF NOT EXISTS produtos (id SERIAL PRIMARY KEY, codigo VARCHAR(255) UNIQUE, nome VARCHAR(255), precoCusto DECIMAL(10,2), precoVenda DECIMAL(10,2), precoPromocao DECIMAL(10,2), emPromocao INTEGER DEFAULT 0, estoque INTEGER, vendidos INTEGER DEFAULT 0)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS vendas (id SERIAL PRIMARY KEY, total DECIMAL(10,2), lucro DECIMAL(10,2), data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        
        await pool.query(`CREATE TABLE IF NOT EXISTS itens_venda (
            id SERIAL PRIMARY KEY,
            venda_id INTEGER,
            produto_codigo VARCHAR(255),
            nome_produto VARCHAR(255),
            preco_custo DECIMAL(10,2),
            preco_venda_real DECIMAL(10,2),
            quantidade INTEGER,
            data_hora TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);

        try { await pool.query("ALTER TABLE produtos ADD COLUMN vendidos INTEGER DEFAULT 0"); } catch (e) { }

        const adminCheck = await pool.query("SELECT * FROM usuarios WHERE usuario = 'admin'");
        if (adminCheck.rows.length === 0) {
            await pool.query("INSERT INTO usuarios (usuario, senha, cargo) VALUES ($1, $2, $3)", ['admin', '123456', 'gerente']);
        }
        console.log("✅ Banco de dados e tabelas detalhadas prontas!");
    } catch (err) {
        console.error("❌ Erro no initDB:", err);
    }
};
initDB();

// ==========================================
// 🛡️ MIDDLEWARES
// ==========================================
function verificarToken(req, res, next) {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ erro: "Acesso negado" });
    jwt.verify(token.split(' ')[1], SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ erro: "Token inválido" });
        req.usuario = decoded;
        next();
    });
}

function tratarNumero(valor) {
    if (valor === undefined || valor === null || valor === '') return 0;
    if (typeof valor === 'number') return valor;
    return parseFloat(valor.toString().replace(/[R$\s.]/g, '').replace(',', '.')) || 0;
}

function permitirCargos(cargosPermitidos) {
    return (req, res, next) => {
        if (!cargosPermitidos.includes(req.usuario.cargo)) return res.status(403).json({ erro: "Sem permissão" });
        next();
    };
}

// ==========================================
// 🔑 ROTAS DE LOGIN E USUÁRIOS
// ==========================================
app.post('/api/login', async (req, res) => {
    const { usuario, senha } = req.body;
    try {
        const result = await pool.query("SELECT * FROM usuarios WHERE usuario = $1 AND senha = $2", [usuario, senha]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            const token = jwt.sign({ id: user.id, cargo: user.cargo }, SECRET, { expiresIn: '8h' });
            res.json({ token, cargo: user.cargo });
        } else {
            res.status(401).json({ erro: "Credenciais inválidas" });
        }
    } catch (err) { res.status(500).json({ erro: "Erro no servidor" }); }
});

app.get('/api/usuarios', verificarToken, permitirCargos(['gerente']), async (req, res) => {
    try {
        const result = await pool.query("SELECT id, usuario, cargo FROM usuarios");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ erro: "Erro ao buscar equipe" }); }
});

// ==========================================
// 📦 ROTAS DE PRODUTOS (Completas)
// ==========================================
app.get('/api/produtos', verificarToken, async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM produtos ORDER BY nome ASC");
        const produtosFormatados = result.rows.map(p => ({
            id: p.id, codigo: p.codigo, nome: p.nome,
            precoCusto: parseFloat(p.precocusto || 0),
            precoVenda: parseFloat(p.precovenda || 0),
            precoPromocao: parseFloat(p.precopromocao || 0),
            emPromocao: parseInt(p.empromocao || 0),
            estoque: parseInt(p.estoque || 0),
            vendidos: parseInt(p.vendidos || 0)
        }));
        res.json(produtosFormatados);
    } catch (err) { res.status(500).json({ erro: "Erro ao buscar produtos" }); }
});

app.post('/api/produtos', verificarToken, permitirCargos(['gerente', 'estoquista']), async (req, res) => {
    const { codigo, nome } = req.body;
    const precoCusto = tratarNumero(req.body.precoCusto);
    const precoVenda = tratarNumero(req.body.precoVenda);
    const precoPromocao = tratarNumero(req.body.precoPromocao);
    const estoque = parseInt(req.body.estoque) || 0;
    const promoFinal = (precoPromocao > 0) ? precoPromocao : precoVenda;
    const emPromocao = promoFinal < precoVenda ? 1 : 0;

    try {
        await pool.query(
            "INSERT INTO produtos (codigo, nome, precoCusto, precoVenda, precoPromocao, emPromocao, estoque) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [codigo, nome, precoCusto, precoVenda, promoFinal, emPromocao, estoque]
        );
        io.emit('atualizacao_geral');
        res.json({ mensagem: "Produto Salvo!" });
    } catch (err) { res.status(500).json({ erro: "Código já existe ou erro no banco" }); }
});

app.put('/api/produtos/:id', verificarToken, permitirCargos(['gerente', 'estoquista']), async (req, res) => {
    const { estoque, precoCusto, precoVenda, precoPromocao } = req.body;
    const promoFinal = parseFloat(precoPromocao) || parseFloat(precoVenda);
    const emPromocao = promoFinal < parseFloat(precoVenda) ? 1 : 0;

    try {
        await pool.query(
            "UPDATE produtos SET estoque = $1, precoCusto = $2, precoVenda = $3, precoPromocao = $4, emPromocao = $5 WHERE id = $6",
            [parseInt(estoque) || 0, parseFloat(precoCusto) || 0, parseFloat(precoVenda) || 0, promoFinal, emPromocao, req.params.id]
        );
        io.emit('atualizacao_geral');
        res.json({ mensagem: "Atualizado com sucesso!" });
    } catch (err) { res.status(500).json({ erro: "Erro ao atualizar" }); }
});

app.put('/api/produtos/:id/promocao', verificarToken, permitirCargos(['gerente']), async (req, res) => {
    try {
        const result = await pool.query("SELECT emPromocao FROM produtos WHERE id = $1", [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ erro: "Produto não encontrado" });
        const novoStatus = result.rows[0].empromocao === 1 ? 0 : 1;
        await pool.query("UPDATE produtos SET emPromocao = $1 WHERE id = $2", [novoStatus, req.params.id]);
        io.emit('atualizacao_geral');
        res.json({ mensagem: "Status alterado!" });
    } catch (err) { res.status(500).json({ erro: "Erro de banco" }); }
});

app.delete('/api/produtos/:id', verificarToken, permitirCargos(['gerente', 'estoquista']), async (req, res) => {
    try {
        await pool.query("DELETE FROM produtos WHERE id = $1", [req.params.id]);
        io.emit('atualizacao_geral');
        res.json({ mensagem: "Excluído!" });
    } catch (err) { res.status(500).json({ erro: "Erro ao excluir" }); }
});

app.post('/api/produtos/lote', verificarToken, permitirCargos(['gerente', 'estoquista']), async (req, res) => {
    const { produtos } = req.body;
    try {
        for (const p of produtos) {
            const precoCusto = tratarNumero(p.precoCusto);
            const precoVenda = tratarNumero(p.precoVenda);
            const precoPromocao = tratarNumero(p.precoPromocao);
            const estoque = parseInt(p.estoque) || 0;
            const promoFinal = (precoPromocao > 0) ? precoPromocao : precoVenda;
            const emPromocao = promoFinal < precoVenda ? 1 : 0;

            await pool.query(
                `INSERT INTO produtos (codigo, nome, precoCusto, precoVenda, precoPromocao, emPromocao, estoque) 
                 VALUES ($1,$2,$3,$4,$5,$6,$7) 
                 ON CONFLICT (codigo) DO UPDATE SET 
                 precoCusto=EXCLUDED.precoCusto, precoVenda=EXCLUDED.precoVenda, precoPromocao=EXCLUDED.precoPromocao, emPromocao=EXCLUDED.emPromocao, estoque=EXCLUDED.estoque`,
                [p.codigo, p.nome, precoCusto, precoVenda, promoFinal, emPromocao, estoque]
            );
        }
        io.emit('atualizacao_geral');
        res.json({ mensagem: "Importação concluída" });
    } catch (err) { res.status(500).json({ erro: "Erro ao processar lote" }); }
});

// ==========================================
// 💸 ROTAS DO CAIXA E VENDAS
// ==========================================
app.post('/api/vendas', verificarToken, permitirCargos(['gerente', 'vendedor']), async (req, res) => {
    const { total, lucro, itens } = req.body;
    try {
        const vendaPrincipal = await pool.query(
            "INSERT INTO vendas (total, lucro) VALUES ($1, $2) RETURNING id", 
            [total, lucro]
        );
        const vendaId = vendaPrincipal.rows[0].id;

        for (const item of itens) {
            await pool.query(
                `INSERT INTO itens_venda (venda_id, produto_codigo, nome_produto, preco_custo, preco_venda_real, quantidade) 
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [vendaId, item.codigo, item.nome, (item.precoUnitario - (item.lucroTotal/item.qtd)), item.precoUnitario, item.qtd]
            );
            await pool.query(
                "UPDATE produtos SET estoque = estoque - $1, vendidos = COALESCE(vendidos, 0) + $1 WHERE codigo = $2", 
                [item.qtd, item.codigo]
            );
        }
        io.emit('atualizacao_geral');
        res.json({ mensagem: "Venda concluída com detalhes!" });
    } catch (err) { res.status(500).json({ erro: "Erro ao fechar venda" }); }
});

// ==========================================
// 📊 DASHBOARD E EXPORTAÇÃO
// ==========================================
app.get('/api/relatorios', verificarToken, permitirCargos(['gerente']), async (req, res) => {
    const { inicio, fim } = req.query;
    let filtroData = "";
    let params = [];

    if (inicio && fim) {
        filtroData = "WHERE data BETWEEN $1 AND $2";
        params = [inicio + " 00:00:00", fim + " 23:59:59"];
    }

    try {
        const vendasTotais = await pool.query(
            `SELECT SUM(total) as faturamento, SUM(lucro) as lucroTotal, COUNT(id) as totalVendas 
             FROM vendas ${filtroData}`, params
        );

        const totais = {
            faturamento: parseFloat(vendasTotais.rows[0].faturamento) || 0,
            lucroTotal: parseFloat(vendasTotais.rows[0].lucrototal) || 0,
            totalVendas: parseInt(vendasTotais.rows[0].totalvendas) || 0,
            margemMedia: 0
        };
        if (totais.faturamento > 0) totais.margemMedia = (totais.lucroTotal / totais.faturamento) * 100;

        const topProd = await pool.query(
            "SELECT nome, vendidos FROM produtos WHERE vendidos > 0 ORDER BY vendidos DESC LIMIT 10"
        );

        res.json({ totais, topProdutos: topProd.rows }); 
    } catch (err) { res.status(500).json({ erro: "Erro nos relatórios" }); }
});

app.get('/api/exportar-vendas', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT produto_codigo, nome_produto, preco_custo, preco_venda_real, quantidade, 
            (preco_venda_real * quantidade) as subtotal,
            TO_CHAR(data_hora, 'DD/MM/YYYY HH24:MI') as momento
            FROM itens_venda 
            ORDER BY data_hora DESC
        `);

        const cabecalho = "SKU;PRODUTO;CUSTO_UN;VENDA_UN;QTD;SUBTOTAL;DATA_HORA\n";
        const linhas = result.rows.map(v => 
            `${v.produto_codigo};${v.nome_produto.toUpperCase()};${v.preco_custo};${v.preco_venda_real};${v.quantidade};${v.subtotal};${v.momento}`
        ).join('\n');
        
        res.header('Content-Type', 'text/csv; charset=utf-8');
        res.attachment('relatorio_detalhado_vendas.csv');
        return res.send('\ufeff' + cabecalho + linhas);
    } catch (err) { res.status(500).send("Erro ao exportar"); }
});

// ==========================================
// 🧹 ROTA DE LIMPEZA GERAL
// ==========================================
app.delete('/api/limpar-vendas', verificarToken, permitirCargos(['gerente']), async (req, res) => {
    try {
        await pool.query("DELETE FROM itens_venda");
        await pool.query("DELETE FROM vendas");
        await pool.query("UPDATE produtos SET vendidos = 0");
        io.emit('atualizacao_geral');
        res.json({ mensagem: "Histórico zerado!" });
    } catch (err) { res.status(500).json({ erro: "Erro ao limpar banco" }); }
});

const PORT = process.env.PORT || 3005;
server.listen(PORT, () => console.log(`🚀 Servidor voando na porta ${PORT}`));