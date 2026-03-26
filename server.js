const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const db = new sqlite3.Database('./data_base/estoque.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS produtos (
        id INTEGER PRIMARY KEY,
        nome TEXT,
        precoCusto REAL,
        precoVenda REAL,
        precoPromocao REAL,
        emPromocao INTEGER, 
        estoque INTEGER
    )`);

    db.get("SELECT COUNT(*) AS total FROM produtos", (err, row) => {
        if (row.total === 0) {
            // Forçamos o ID 1 para ter certeza de que ele existe
            db.run(`INSERT INTO produtos (id, nome, precoCusto, precoVenda, precoPromocao, emPromocao, estoque) 
                    VALUES (1, 'Teclado Mecânico', 100.00, 250.00, 150.00, 0, 50)`, (err) => {
                if (!err) console.log("✅ Produto inserido no banco de dados com sucesso!");
            });
        } else {
            console.log("✅ Banco de dados lido com sucesso! Produto já existe.");
        }
    });
});

io.on('connection', (socket) => {
    console.log('💻 Navegador conectou! Buscando dados no banco...');
    
    // Pequeno atraso intencional de 500ms para dar tempo do banco salvar na primeira vez
    setTimeout(() => {
        db.get("SELECT * FROM produtos WHERE id = 1", (err, produto) => {
            if (produto) {
                console.log('📦 Produto encontrado! Enviando para a tela...');
                socket.emit('dados_iniciais', {
                    nome: produto.nome,
                    estoque: produto.estoque,
                    precoAtual: produto.emPromocao === 1 ? produto.precoPromocao : produto.precoVenda,
                    emPromocao: produto.emPromocao === 1
                });
            } else {
                console.log('⚠️ ERRO: O produto não foi encontrado no banco.');
            }
        });
    }, 500);
});

app.post('/vender', (req, res) => {
    db.get("SELECT * FROM produtos WHERE id = 1", (err, produto) => {
        if (produto && produto.estoque > 0) {
            db.run("UPDATE produtos SET estoque = estoque - 1 WHERE id = 1", () => {
                const precoAtual = produto.emPromocao === 1 ? produto.precoPromocao : produto.precoVenda;
                const lucro = precoAtual - produto.precoCusto;
                const margem = (lucro / precoAtual) * 100;
                const markup = (lucro / produto.precoCusto) * 100;

                io.emit('atualizacao_estoque', {
                    novoEstoque: produto.estoque - 1,
                    lucroGerado: lucro,
                    margem: margem,
                    markup: markup,
                    mensagem: `Venda registrada! Lucro: R$ ${lucro.toFixed(2)}`
                });
                res.send("Venda registrada!");
            });
        }
    });
});

app.post('/toggle-promocao', (req, res) => {
    db.get("SELECT emPromocao, precoVenda, precoPromocao FROM produtos WHERE id = 1", (err, produto) => {
        if (produto) {
            const novoEstado = produto.emPromocao === 1 ? 0 : 1;
            const precoAtual = novoEstado === 1 ? produto.precoPromocao : produto.precoVenda;

            db.run("UPDATE produtos SET emPromocao = ? WHERE id = 1", [novoEstado], () => {
                io.emit('status_promocao', { 
                    emPromocao: novoEstado === 1,
                    precoAtual: precoAtual
                });
                res.send("Promoção alterada!");
            });
        }
    });
});

server.listen(3005, () => {
    console.log('🚀 Servidor rodando em http://localhost:3005');
});