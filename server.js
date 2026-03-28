const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs'); // Adicionamos o File System

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Chave secreta para assinar os crachás (Em um sistema real, isso fica em um arquivo .env)
const SEGREDO_JWT = 'pdv-secreto-rafa-2026';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json()); 

// Verifica se a pasta existe. Se não existir, ele cria!
if (!fs.existsSync('./database')) {
    fs.mkdirSync('./database');
}

const db = new sqlite3.Database('./database/estoque.db');

// 1. Criação das Tabelas Atualizadas
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS produtos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT UNIQUE, 
        nome TEXT,
        precoCusto REAL,
        precoVenda REAL,
        precoPromocao REAL,
        emPromocao INTEGER DEFAULT 0,
        estoque INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS vendas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        produto_id INTEGER,
        quantidade INTEGER,
        valorTotal REAL,
        lucro REAL,
        margem REAL,
        markup REAL,
        data_venda DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(produto_id) REFERENCES produtos(id)
    )`);

    // Criação da tabela de Usuários
    db.run(`CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario TEXT UNIQUE,
        senha TEXT
    )`, () => {
        // Cria um usuário padrão (admin / 123456) caso não exista nenhum
        db.get("SELECT * FROM usuarios WHERE usuario = 'admin'", [], (err, row) => {
            if (!row) {
                const senhaCriptografada = bcrypt.hashSync('123456', 8);
                db.run("INSERT INTO usuarios (usuario, senha) VALUES (?, ?)", ['admin', senhaCriptografada]);
            }
        });
    });

});
// ==========================================
// SISTEMA DE LOGIN E SEGURANÇA (JWT)
// ==========================================

// Rota de Autenticação (Gera o Token)
app.post('/api/login', (req, res) => {
    const { usuario, senha } = req.body;

    db.get("SELECT * FROM usuarios WHERE usuario = ?", [usuario], (err, user) => {
        if (err) return res.status(500).json({ erro: "Erro no servidor" });
        if (!user) return res.status(401).json({ erro: "Usuário ou senha incorretos" });

        // Verifica se a senha bate com a criptografada no banco
        const senhaValida = bcrypt.compareSync(senha, user.senha);
        if (!senhaValida) return res.status(401).json({ erro: "Usuário ou senha incorretos" });

        // Se tudo der certo, gera o "crachá" válido por 8 horas
        const token = jwt.sign({ id: user.id, usuario: user.usuario }, SEGREDO_JWT, { expiresIn: '8h' });
        res.json({ mensagem: "Login efetuado com sucesso!", token });
    });
});

// Middleware: O "Segurança" que vai barrar as requisições sem crachá
const verificarToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(403).json({ erro: "Acesso negado. Token não fornecido." });

    // O token geralmente vem como "Bearer xyz123"
    const tokenLimpo = token.split(' ')[1]; 

    jwt.verify(tokenLimpo, SEGREDO_JWT, (err, decoded) => {
        if (err) return res.status(401).json({ erro: "Token inválido ou expirado." });
        req.usuarioId = decoded.id; // Salva o ID do usuário para usar depois
        next(); // Deixa o usuário passar
    });
};

// ==========================================
// APLICANDO A BARREIRA NAS ROTAS
// ==========================================
// Importante: Aplique o `verificarToken` em todas as rotas da sua API a partir daqui.
// Exemplo de como fica a sua rota de vender agora:
// app.post('/api/vender', verificarToken, (req, res) => { ... })
// app.get('/api/produtos', verificarToken, (req, res) => { ... })
// app.get('/api/relatorios', verificarToken, (req, res) => { ... })



// ==========================================
// ROTAS DA API REST (GERENCIAMENTO)
// ==========================================

// Listar todos os produtos
app.get('/api/produtos', (req, res) => {
    db.all("SELECT * FROM produtos", [], (err, rows) => {
        if (err) return res.status(500).json({ erro: err.message });
        res.json(rows);
    });
});

// Cadastrar Produto (agora aceita precoPromocao opcional)
app.post('/api/produtos', (req, res) => {
    const { codigo, nome, precoCusto, precoVenda, estoque, precoPromocao } = req.body;
    // Se não enviar preço de promoção, ele fica igual ao de venda por padrão
    const valorPromo = precoPromocao || precoVenda; 

    db.run(`INSERT INTO produtos (codigo, nome, precoCusto, precoVenda, precoPromocao, estoque) VALUES (?, ?, ?, ?, ?, ?)`,
        [codigo, nome, precoCusto, precoVenda, valorPromo, estoque],
        function(err) {
            if (err) return res.status(400).json({ erro: "Erro ao cadastrar. O código já existe?" });
            io.emit('atualizacao_geral');
            res.json({ id: this.lastID, mensagem: "Produto cadastrado com sucesso!" });
        }
    );
});

// Atualizar Produto Completo
app.put('/api/produtos/:id', (req, res) => {
    const id = req.params.id;
    const { codigo, nome, precoCusto, precoVenda, precoPromocao, estoque } = req.body;

    db.run(
        `UPDATE produtos SET codigo = ?, nome = ?, precoCusto = ?, precoVenda = ?, precoPromocao = ?, estoque = ? WHERE id = ?`,
        [codigo, nome, precoCusto, precoVenda, precoPromocao, estoque, id],
        function(err) {
            if (err) return res.status(400).json({ erro: "Erro ao atualizar produto." });
            io.emit('atualizacao_geral');
            res.json({ mensagem: "Produto atualizado com sucesso!" });
        }
    );
});

// Nova Rota: Ativar/Desativar Promoção
app.put('/api/produtos/:id/promocao', verificarToken, (req, res) => {
    const id = req.params.id;
    
    db.get("SELECT emPromocao FROM produtos WHERE id = ?", [id], (err, produto) => {
        if (err || !produto) return res.status(404).json({ erro: "Produto não encontrado" });
        
        const novoEstado = produto.emPromocao === 1 ? 0 : 1;
        
        db.run("UPDATE produtos SET emPromocao = ? WHERE id = ?", [novoEstado, id], () => {
            io.emit('atualizacao_geral');
            res.json({ mensagem: novoEstado === 1 ? "Promoção Ativada!" : "Promoção Desativada!" });
        });
    });
});

// Excluir Produto
app.delete('/api/produtos/:id', verificarToken, (req, res) => {
    const id = req.params.id;
    db.run(`DELETE FROM produtos WHERE id = ?`, id, function(err) {
        if (err) return res.status(500).json({ erro: err.message });
        io.emit('atualizacao_geral');
        res.json({ mensagem: "Produto excluído!" });
    });
});


// ==========================================
// EXTRAÇÃO E INSERÇÃO EM ESCALA (LOTE)
// ==========================================

// 1. Rota para Exportar Relatório de Vendas (CSV)
app.get('/api/exportar-vendas', (req, res) => {
    db.all(`SELECT v.id, p.codigo, p.nome, v.quantidade, v.valorTotal, v.lucro, v.margem, v.data_venda 
            FROM vendas v JOIN produtos p ON v.produto_id = p.id ORDER BY v.id DESC`, [], (err, rows) => {
        
        if (err) return res.status(500).send("Erro ao gerar relatório");

        // Monta o cabeçalho do arquivo Excel/CSV
        let csv = "ID da Venda;Codigo SKU;Produto;Qtd Vendida;Valor Total;Lucro;Margem(%);Data e Hora\n";
        
        // Preenche com os dados do banco
        rows.forEach(r => {
            // Converte a data do SQLite para o padrão brasileiro local
            const dataLocal = new Date(r.data_venda + 'Z').toLocaleString('pt-BR');
            csv += `${r.id};${r.codigo};"${r.nome}";${r.quantidade};${r.valorTotal.toFixed(2)};${r.lucro.toFixed(2)};${r.margem.toFixed(2)};${dataLocal}\n`;
        });

        // Configura o navegador para fazer o download automático do arquivo
        res.header('Content-Type', 'text/csv; charset=utf-8');
        res.attachment('relatorio_vendas.csv');
        return res.send('\uFEFF' + csv); // \uFEFF força o Excel a ler os acentos corretamente (UTF-8)
    });
});

// 2. Rota para Inserir/Atualizar Estoque em Lote
app.post('/api/produtos/lote', verificarToken, (req, res) => {
    const { produtos } = req.body;
    if (!produtos || !produtos.length) return res.status(400).json({erro: "Nenhum produto enviado"});

    // O SQLite fará um "UPSERT": Se o código não existir, ele cria. Se existir, ele soma o estoque e atualiza os preços.
    db.serialize(() => {
        const stmt = db.prepare(`INSERT INTO produtos (codigo, nome, precoCusto, precoVenda, precoPromocao, estoque)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(codigo) DO UPDATE SET
            nome=excluded.nome, precoCusto=excluded.precoCusto, precoVenda=excluded.precoVenda, 
            precoPromocao=excluded.precoPromocao, estoque = produtos.estoque + excluded.estoque`);
        
        produtos.forEach(p => {
            const promo = p.precoPromocao || p.precoVenda;
            stmt.run(p.codigo, p.nome, parseFloat(p.precoCusto), parseFloat(p.precoVenda), parseFloat(promo), parseInt(p.estoque));
        });
        stmt.finalize();
    });

    io.emit('atualizacao_geral');
    res.json({ mensagem: `${produtos.length} produtos processados com sucesso!` });
});

// ==========================================
// LÓGICA DE FRENTE DE CAIXA (PDV)
// ==========================================

app.post('/api/vender', verificarToken, (req, res) => {
    const { codigo, quantidade } = req.body;
    
    db.get("SELECT * FROM produtos WHERE codigo = ?", [codigo], (err, produto) => {
        if (err || !produto) return res.status(404).json({ erro: "Produto não encontrado!" });
        
        if (produto.estoque >= quantidade) {
            // 1. Identifica o preço atual (Normal ou Promoção)
            const precoAtual = produto.emPromocao === 1 ? produto.precoPromocao : produto.precoVenda;
            
            // 2. Cálculos Financeiros Base
            const valorTotal = precoAtual * quantidade;
            const lucroUnitario = precoAtual - produto.precoCusto;
            const lucroTotal = lucroUnitario * quantidade;
            
            // 3. Cálculos de Margem e Markup
            // Margem = (Lucro / Preço de Venda) * 100 -> Quanto do preço final é lucro
            const margem = precoAtual > 0 ? (lucroUnitario / precoAtual) * 100 : 0;
            // Markup = (Lucro / Custo) * 100 -> Quanto foi adicionado sobre o custo
            const markup = produto.precoCusto > 0 ? (lucroUnitario / produto.precoCusto) * 100 : 0;

            const novoEstoque = produto.estoque - quantidade;

            // 4. Salva as alterações no banco
            db.run("UPDATE produtos SET estoque = ? WHERE id = ?", [novoEstoque, produto.id], () => {
                db.run(`INSERT INTO vendas (produto_id, quantidade, valorTotal, lucro, margem, markup) 
                        VALUES (?, ?, ?, ?, ?, ?)`,
                    [produto.id, quantidade, valorTotal, lucroTotal, margem, markup], () => {
                        
                        // 5. Emite evento para os painéis
                        io.emit('venda_realizada', {
                            codigo: produto.codigo,
                            nome: produto.nome,
                            novoEstoque: novoEstoque,
                            valorTotal: valorTotal,
                            lucro: lucroTotal,
                            margem: margem,
                            markup: markup,
                            emPromocao: produto.emPromocao === 1
                        });
                        
                        res.json({ mensagem: "Venda registrada!", lucro: lucroTotal });
                });
            });
        } else {
            res.status(400).json({ erro: "Estoque insuficiente!" });
        }
    });
});

// ==========================================
// ROTA DE RELATÓRIOS E DASHBOARD
// ==========================================
app.get('/api/relatorios', verificarToken, (req, res) => {
    // 1. Busca os totais gerais
    db.get(`SELECT 
            IFNULL(SUM(valorTotal), 0) as faturamento, 
            IFNULL(SUM(lucro), 0) as lucroTotal, 
            IFNULL(AVG(margem), 0) as margemMedia,
            COUNT(id) as totalVendas 
            FROM vendas`, [], (err, totais) => {
        
        if (err) return res.status(500).json({ erro: err.message });

        // 2. Busca o Top 5 produtos mais vendidos para o Gráfico
        db.all(`SELECT p.nome, SUM(v.quantidade) as qtdVendida 
                FROM vendas v 
                JOIN produtos p ON v.produto_id = p.id 
                GROUP BY p.id 
                ORDER BY qtdVendida DESC LIMIT 5`, [], (err, topProdutos) => {
            
            if (err) return res.status(500).json({ erro: err.message });

            // Envia tudo empacotado para o frontend
            res.json({ totais, topProdutos });
        });
    });
});

server.listen(3005, () => {
    console.log('🚀 Servidor rodando em http://localhost:3005');
});