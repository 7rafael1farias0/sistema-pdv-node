const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

// Garante que a pasta database existe para o SQLite não dar erro no Deploy
const dir = './database';
if (!fs.existsSync(dir)){
    fs.mkdirSync(dir);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

const SEGREDO_JWT = 'pdv-secreto-rafa-2026';

// Conexão com o Banco de Dados
const db = new sqlite3.Database('./database/estoque.db', (err) => {
    if (err) console.error("Erro ao conectar ao banco:", err.message);
    else console.log("Conectado ao banco de dados SQLite.");
});

// Criação das Tabelas
db.serialize(() => {
    // Tabela de Produtos
    db.run(`CREATE TABLE IF NOT EXISTS produtos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT UNIQUE,
        nome TEXT,
        precoCusto REAL,
        precoVenda REAL,
        precoPromocao REAL,
        estoque INTEGER,
        emPromocao INTEGER DEFAULT 0
    )`);

    // Tabela de Vendas (Histórico)
    db.run(`CREATE TABLE IF NOT EXISTS vendas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        produto_id INTEGER,
        quantidade INTEGER,
        valorTotal REAL,
        lucro REAL,
        margem REAL,
        data_venda DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(produto_id) REFERENCES produtos(id)
    )`);

    // Tabela de Usuários
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario TEXT UNIQUE,
        senha TEXT
    )`, () => {
        db.get("SELECT * FROM usuarios WHERE usuario = 'admin'", [], (err, row) => {
            if (!row) {
                const senhaCriptografada = bcrypt.hashSync('123456', 8);
                db.run("INSERT INTO usuarios (usuario, senha) VALUES (?, ?)", ['admin', senhaCriptografada]);
            }
        });
    });
});

// ==========================================
// LOGIN E SEGURANÇA
// ==========================================
app.post('/api/login', (req, res) => {
    const { usuario, senha } = req.body;
    db.get("SELECT * FROM usuarios WHERE usuario = ?", [usuario], (err, user) => {
        if (err || !user || !bcrypt.compareSync(senha, user.senha)) {
            return res.status(401).json({ erro: "Usuário ou senha incorretos" });
        }
        const token = jwt.sign({ id: user.id, usuario: user.usuario }, SEGREDO_JWT, { expiresIn: '8h' });
        res.json({ mensagem: "Sucesso", token });
    });
});

const verificarToken = (req, res, next) => {
    // Aceita token pelo Header ou pela URL (para o caso do download do CSV)
    const tokenHeader = req.headers['authorization'];
    const tokenQuery = req.query.token;
    
    let tokenLimpo = null;
    if (tokenHeader) tokenLimpo = tokenHeader.split(' ')[1];
    else if (tokenQuery) tokenLimpo = tokenQuery;

    if (!tokenLimpo) return res.status(403).json({ erro: "Acesso negado. Faça login." });

    jwt.verify(tokenLimpo, SEGREDO_JWT, (err, decoded) => {
        if (err) return res.status(401).json({ erro: "Token inválido ou expirado." });
        req.usuarioId = decoded.id;
        next();
    });
};

// ==========================================
// ROTAS DE PRODUTOS E ESTOQUE
// ==========================================
app.get('/api/produtos', verificarToken, (req, res) => {
    db.all("SELECT * FROM produtos", [], (err, rows) => {
        if (err) return res.status(500).json({erro: err.message});
        res.json(rows);
    });
});

app.post('/api/produtos', verificarToken, (req, res) => {
    const { codigo, nome, precoCusto, precoVenda, precoPromocao, estoque } = req.body;
    db.run(`INSERT INTO produtos (codigo, nome, precoCusto, precoVenda, precoPromocao, estoque) VALUES (?, ?, ?, ?, ?, ?)`,
        [codigo, nome, precoCusto, precoVenda, precoPromocao, estoque], function(err) {
            if (err) return res.status(400).json({erro: "Código já cadastrado!"});
            io.emit('atualizacao_geral');
            res.json({ id: this.lastID });
    });
});

app.put('/api/produtos/:id', verificarToken, (req, res) => {
    const { codigo, nome, precoCusto, precoVenda, precoPromocao, estoque } = req.body;
    db.run(`UPDATE produtos SET codigo = ?, nome = ?, precoCusto = ?, precoVenda = ?, precoPromocao = ?, estoque = ? WHERE id = ?`,
        [codigo, nome, precoCusto, precoVenda, precoPromocao, estoque, req.params.id], function(err) {
            if (err) return res.status(500).json({erro: err.message});
            io.emit('atualizacao_geral');
            res.json({ mensagem: "Atualizado com sucesso" });
    });
});

app.put('/api/produtos/:id/promocao', verificarToken, (req, res) => {
    db.run(`UPDATE produtos SET emPromocao = CASE WHEN emPromocao = 1 THEN 0 ELSE 1 END WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({erro: err.message});
        io.emit('atualizacao_geral');
        res.json({ mensagem: "Promoção alterada" });
    });
});

app.delete('/api/produtos/:id', verificarToken, (req, res) => {
    db.run(`DELETE FROM produtos WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({erro: err.message});
        io.emit('atualizacao_geral');
        res.json({ mensagem: "Excluído com sucesso" });
    });
});

app.post('/api/produtos/lote', verificarToken, (req, res) => {
    const { produtos } = req.body;
    if (!produtos || !produtos.length) return res.status(400).json({erro: "Nenhum produto enviado"});

    db.serialize(() => {
        const stmt = db.prepare(`INSERT INTO produtos (codigo, nome, precoCusto, precoVenda, precoPromocao, estoque) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(codigo) DO UPDATE SET nome=excluded.nome, precoCusto=excluded.precoCusto, precoVenda=excluded.precoVenda, precoPromocao=excluded.precoPromocao, estoque = produtos.estoque + excluded.estoque`);
        produtos.forEach(p => {
            const promo = p.precoPromocao || p.precoVenda;
            stmt.run(p.codigo, p.nome, parseFloat(p.precoCusto), parseFloat(p.precoVenda), parseFloat(promo), parseInt(p.estoque));
        });
        stmt.finalize();
    });
    io.emit('atualizacao_geral');
    res.json({ mensagem: "Processado com sucesso" });
});

// ==========================================
// FRENTE DE CAIXA E DASHBOARD
// ==========================================
app.post('/api/vender', verificarToken, (req, res) => {
    const { codigo, quantidade } = req.body;

    db.get(`SELECT * FROM produtos WHERE codigo = ?`, [codigo], (err, produto) => {
        if (!produto) return res.status(404).json({ erro: "Produto não encontrado!" });
        if (produto.estoque < quantidade) return res.status(400).json({ erro: "Estoque insuficiente!" });

        const precoFinal = produto.emPromocao ? produto.precoPromocao : produto.precoVenda;
        const valorTotal = precoFinal * quantidade;
        const custoTotal = produto.precoCusto * quantidade;
        const lucro = valorTotal - custoTotal;
        const margem = valorTotal > 0 ? (lucro / valorTotal) * 100 : 0;
        const novoEstoque = produto.estoque - quantidade;

        db.serialize(() => {
            db.run(`UPDATE produtos SET estoque = ? WHERE id = ?`, [novoEstoque, produto.id]);
            db.run(`INSERT INTO vendas (produto_id, quantidade, valorTotal, lucro, margem) VALUES (?, ?, ?, ?, ?)`,
                [produto.id, quantidade, valorTotal, lucro, margem]);
            
            io.emit('venda_realizada', { 
                nome: produto.nome, valorTotal, lucro, margem, novoEstoque, emPromocao: produto.emPromocao 
            });
            res.json({ mensagem: "Venda registrada com sucesso" });
        });
    });
});

app.get('/api/relatorios', verificarToken, (req, res) => {
    const dashboard = { totais: {}, topProdutos: [] };

    db.get(`SELECT COALESCE(SUM(valorTotal), 0) as faturamento, COALESCE(SUM(lucro), 0) as lucroTotal, COALESCE(AVG(margem), 0) as margemMedia, COUNT(id) as totalVendas FROM vendas`, [], (err, totais) => {
        dashboard.totais = totais;

        db.all(`SELECT p.nome, SUM(v.quantidade) as qtdVendida FROM vendas v JOIN produtos p ON v.produto_id = p.id GROUP BY p.id ORDER BY qtdVendida DESC LIMIT 5`, [], (err, produtos) => {
            dashboard.topProdutos = produtos;
            res.json(dashboard);
        });
    });
});

app.get('/api/exportar-vendas', verificarToken, (req, res) => {
    db.all(`SELECT v.id, p.codigo, p.nome, v.quantidade, v.valorTotal, v.lucro, v.margem, v.data_venda FROM vendas v JOIN produtos p ON v.produto_id = p.id ORDER BY v.id DESC`, [], (err, rows) => {
        if (err) return res.status(500).send("Erro");
        let csv = "ID da Venda;Codigo SKU;Produto;Qtd Vendida;Valor Total;Lucro;Margem(%);Data e Hora\n";
        rows.forEach(r => {
            const dataLocal = new Date(r.data_venda + 'Z').toLocaleString('pt-BR');
            csv += `${r.id};${r.codigo};"${r.nome}";${r.quantidade};${r.valorTotal.toFixed(2)};${r.lucro.toFixed(2)};${r.margem.toFixed(2)};${dataLocal}\n`;
        });
        res.header('Content-Type', 'text/csv; charset=utf-8');
        res.attachment('relatorio_vendas.csv');
        res.send('\uFEFF' + csv);
    });
});

const PORT = process.env.PORT || 3005;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));