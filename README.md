# 📊 Painel de Gestão Financeira em Tempo Real

Um sistema de gestão de estoque e cálculo de lucros em tempo real construído com Node.js. O painel calcula dinamicamente Margem de Lucro e Markup, simulando a integração instantânea entre um PDV e o backoffice de uma loja usando WebSockets.

## 🚀 Tecnologias Utilizadas
* **Backend:** Node.js, Express
* **Banco de Dados:** SQLite (Relacional)
* **Comunicação em Tempo Real:** Socket.io (WebSockets)
* **Frontend:** HTML5, CSS3, JavaScript Vanilla

## ⚙️ Funcionalidades
* Persistência de dados com SQLite.
* Atualização de estoque e lucros no front-end em milissegundos, sem recarregar a página.
* Sistema de "Preço Promocional" com recálculo dinâmico de indicadores financeiros.