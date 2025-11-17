import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// Lê o webhook do Bitrix das variáveis de ambiente do Render
const rawBase = process.env.BITRIX_WEBHOOK_BASE;

// segurança extra: garante que tem exatamente 1 barra no final
const BITRIX_WEBHOOK_BASE = (rawBase || "").replace(/\/+$/, "") + "/";

if (!rawBase) {
  console.error("ERRO: BITRIX_WEBHOOK_BASE não definido nas variáveis de ambiente");
}

// helper pra montar URL correta do método REST
function bitrixUrl(method) {
  const url = `${BITRIX_WEBHOOK_BASE}${method}.json`;
  console.log("URL Bitrix usada:", url);
  return url;
}

// Rota que a Shopify chama
app.post("/webhook", async (req, res) => {
  try {
    const order = req.body;
    console.log("Pedido recebido da Shopify:", order.id, `#${order.name}`);

    // Exemplo: criar um negócio (deal) simples no Bitrix
    const url = bitrixUrl("crm.deal.add");

    const payload = {
      fields: {
        TITLE: `Pedido Shopify ${order.name || order.id}`,
        OPPORTUNITY: order.total_price ? Number(order.total_price) : 0,
        CURRENCY_ID: order.currency || "BRL",
        COMMENTS: `Pedido Shopify bruto:\n${JSON.stringify(order, null, 2)}`,
      }
    };

    const response = await axios.post(url, payload);

    console.log("Resposta Bitrix:", response.data);

    if (response.data.error) {
      console.error("Erro Bitrix:", response.data);
      return res.status(500).send("Erro Bitrix: " + response.data.error_description);
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Erro integração Shopify → Bitrix:");
    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", err.response.data);
    } else {
      console.error(err.message);
    }
    res.status(500).send("Erro ao integrar");
  }
});

// Porta obrigatória no Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor ouvindo na porta", PORT);
});
