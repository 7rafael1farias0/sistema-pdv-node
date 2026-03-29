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

// ==========================================
// ☁️ CONEXÃO COM O BANCO DE DADOS POSTGRESQL
// ==========================================
// Se estiver no Render, ele usa a URL da nuvem. Se estiver no seu PC, ele pode rodar local (se você configurar) ou dar erro.
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:senha@localhost:5432/pdv',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false // Exigência do Render gratuito
});

// Inicialização das Tabelas no Postgres
const initDB = async () => {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS usuarios (id SERIAL PRIMARY KEY, usuario VARCHAR(255) UNIQUE, senha VARCHAR(255), cargo VARCHAR(50))`);
        await pool.query(`CREATE TABLE IF NOT EXISTS produtos (id SERIAL PRIMARY KEY, codigo VARCHAR(255) UNIQUE, nome VARCHAR(255), precoCusto DECIMAL(10,2), precoVenda DECIMAL(10,2), precoPromocao DECIMAL(10,2), emPromocao INTEGER DEFAULT 0, estoque INTEGER)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS vendas (id SERIAL PRIMARY KEY, total DECIMAL(10,2), lucro DECIMAL(10,2), data TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        
        const adminCheck = await pool.query("SELECT * FROM usuarios WHERE usuario = 'admin'");
        if (adminCheck.rows.length === 0) {
            await pool.query("INSERT INTO usuarios (usuario, senha, cargo) VALUES ($1, $2, $3)", ['admin', '123456', 'gerente']);
            console.log("👑 Usuário admin padrão recriado na nuvem.");
        }
        console.log("✅ Banco de dados conectado e tabelas verificadas.");
    } catch (err) {
        console.error("❌ Erro ao criar tabelas no Postgres:", err);
    }
};
initDB();

// ==========================================
// 🛡️ MIDDLEWARES E SEGURANÇA
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

app.post('/api/usuarios', verificarToken, permitirCargos(['gerente']), async (req, res) => {
    const { usuario, senha, cargo } = req.body;
    try {
        await pool.query("INSERT INTO usuarios (usuario, senha, cargo) VALUES ($1, $2, $3)", [usuario, senha, cargo]);
        res.json({ mensagem: "Usuário criado!" });
    } catch (err) { res.status(400).json({ erro: "Usuário já existe ou erro de banco" }); }
});

app.delete('/api/usuarios/:id', verificarToken, permitirCargos(['gerente']), async (req, res) => {
    if (parseInt(req.params.id) === req.usuario.id) return res.status(400).json({ erro: "Você não pode excluir a si mesmo!" });
    try {
        await pool.query("DELETE FROM usuarios WHERE id = $1", [req.params.id]);
        res.json({ mensagem: "Excluído com sucesso" });
    } catch (err) { res.status(500).json({ erro: "Erro ao excluir" }); }
});

// ==========================================
// 📦 ROTAS DE PRODUTOS (ESTOQUE)
// ==========================================
app.get('/api/produtos', verificarToken, async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM produtos ORDER BY nome ASC");
        res.json(result.rows);
    } catch (err) { res.status(500).json({ erro: "Erro ao buscar produtos" }); }
});

app.post('/api/produtos', verificarToken, permitirCargos(['gerente', 'estoquista']), async (req, res) => {
    const { codigo, nome, precoCusto, precoVenda, precoPromocao, estoque } = req.body;
    const promoFinal = (precoPromocao && precoPromocao > 0) ? precoPromocao : precoVenda;
    const emPromocao = promoFinal < precoVenda ? 1 : 0;
    
    try {
        await pool.query("INSERT INTO produtos (codigo, nome, precoCusto, precoVenda, precoPromocao, emPromocao, estoque) VALUES ($1,$2,$3,$4,$5,$6,$7)", 
        [codigo, nome, precoCusto, precoVenda, promoFinal, emPromocao, estoque]);
        io.emit('atualizacao_geral');
        res.json({ mensagem: "Produto Salvo!" });
    } catch (err) { res.status(500).json({ erro: "Código já existe ou erro no servidor" }); }
});

app.put('/api/produtos/:id', verificarToken, permitirCargos(['gerente', 'estoquista']), async (req, res) => {
    const estoque = parseInt(req.body.estoque) || 0;
    const precoCusto = parseFloat(req.body.precoCusto) || 0;
    const precoVenda = parseFloat(req.body.precoVenda) || 0;
    const precoPromocao = parseFloat(req.body.precoPromocao) || precoVenda;
    const emPromocao = precoPromocao < precoVenda ? 1 : 0;
    
    try {
        await pool.query("UPDATE produtos SET estoque = $1, precoCusto = $2, precoVenda = $3, precoPromocao = $4, emPromocao = $5 WHERE id = $6", 
        [estoque, precoCusto, precoVenda, precoPromocao, emPromocao, req.params.id]);
        io.emit('atualizacao_geral');
        res.json({ mensagem: "Atualizado!" });
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

// Importação CSV em Lote
app.post('/api/produtos/lote', verificarToken, permitirCargos(['gerente', 'estoquista']), async (req, res) => {
    const { produtos } = req.body;
    try {
        for (const p of produtos) {
            const promoFinal = (p.precoPromocao && p.precoPromocao > 0) ? p.precoPromocao : p.precoVenda;
            const emPromocao = promoFinal < p.precoVenda ? 1 : 0;
            
            // Faz Inserção ou Atualização se o código já existir
            await pool.query(
                `INSERT INTO produtos (codigo, nome, precoCusto, precoVenda, precoPromocao, emPromocao, estoque) 
                 VALUES ($1,$2,$3,$4,$5,$6,$7) 
                 ON CONFLICT (codigo) DO UPDATE SET 
                 precoCusto=EXCLUDED.precoCusto, precoVenda=EXCLUDED.precoVenda, precoPromocao=EXCLUDED.precoPromocao, emPromocao=EXCLUDED.emPromocao, estoque=EXCLUDED.estoque`,
                [p.codigo, p.nome, p.precoCusto, p.precoVenda, promoFinal, emPromocao, p.estoque]
            );
        }
        io.emit('atualizacao_geral');
        res.json({ mensagem: "Importação concluída" });
    } catch (err) { res.status(500).json({ erro: "Erro ao processar lote CSV" }); }
});

// ==========================================
// 💸 ROTAS DO CAIXA E DASHBOARD
// ==========================================
app.post('/api/vendas', verificarToken, permitirCargos(['gerente', 'vendedor']), async (req, res) => {
    const { total, lucro, itens } = req.body;
    try {
        // Registra a venda financeira
        await pool.query("INSERT INTO vendas (total, lucro) VALUES ($1, $2)", [total, lucro]);
        
        // Baixa o estoque de cada item
        for (const item of itens) {
            await pool.query("UPDATE produtos SET estoque = estoque - $1 WHERE codigo = $2", [item.qtd, item.codigo]);
        }
        
        io.emit('atualizacao_geral');
        res.json({ mensagem: "Venda concluída!" });
    } catch (err) { res.status(500).json({ erro: "Erro ao fechar venda" }); }
});

app.get('/api/relatorios', verificarToken, permitirCargos(['gerente']), async (req, res) => {
    try {
        // Em um sistema real, aqui você faria joins complexos. Para o MVP, buscamos os totais
        const vendas = await pool.query("SELECT SUM(total) as faturamento, SUM(lucro) as lucroTotal, COUNT(id) as totalVendas FROM vendas");
        const totais = {
            faturamento: parseFloat(vendas.rows[0].faturamento) || 0,
            lucroTotal: parseFloat(vendas.rows[0].lucrototal) || 0,
            totalVendas: parseInt(vendas.rows[0].totalvendas) || 0,
            margemMedia: 0
        };
        
        if (totais.faturamento > 0) totais.margemMedia = (totais.lucroTotal / totais.faturamento) * 100;

        res.json({ totais, topProdutos: [] }); // Simplificado para garantir compatibilidade
    } catch (err) { res.status(500).json({ erro: "Erro ao gerar relatórios" }); }
});

app.get('/api/exportar-vendas', async (req, res) => {
    try {
        const result = await pool.query("SELECT id, total, lucro, data FROM vendas ORDER BY data DESC");
        const cabecalho = "ID;Total;Lucro;Data\n";
        const linhas = result.rows.map(v => `${v.id};${v.total};${v.lucro};${new Date(v.data).toLocaleString()}`).join('\n');
        
        res.header('Content-Type', 'text/csv');
        res.attachment('historico_vendas.csv');
        return res.send(cabecalho + linhas);
    } catch (err) { res.status(500).send("Erro ao exportar"); }
});

// A NUVEM DEFINE A PORTA (Obrigatório para o Render)
const PORT = process.env.PORT || 3005;
server.listen(PORT, () => console.log(`🚀 Servidor voando na porta ${PORT}`));