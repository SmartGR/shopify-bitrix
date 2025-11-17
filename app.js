// Carrega variáveis do .env
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// URL base do webhook do Bitrix (SEM método no final)
const BITRIX_WEBHOOK_BASE = process.env.BITRIX_WEBHOOK_BASE;

// Só pra garantir que você não esqueceu do .env
if (!BITRIX_WEBHOOK_BASE) {
  console.error('ERRO: BITRIX_WEBHOOK_BASE não definido no arquivo .env');
  process.exit(1);
}

// Endpoint que o Shopify vai chamar
app.post('/shopify-order', async (req, res) => {
  try {
    const order = req.body;
    console.log('Pedido recebido do Shopify:', order.id, order.name);

    // 1) Pegar dados do cliente
    const customer = order.customer || {};
    const firstName = customer.first_name || '';
    const lastName = customer.last_name || '';
    const email = customer.email || '';
    const phone = (customer.phone || '').toString();
    const totalPrice = order.total_price;
    const currency = order.currency || 'BRL';
    const orderName = order.name; // ex: #1001

    // 2) Criar contato no Bitrix
    const contactResp = await axios.post(
      `${BITRIX_WEBHOOK_BASE}/crm.contact.add.json`,
      {
        fields: {
          NAME: firstName,
          LAST_NAME: lastName,
          EMAIL: email ? [{ VALUE: email, VALUE_TYPE: 'WORK' }] : [],
          PHONE: phone ? [{ VALUE: phone, VALUE_TYPE: 'WORK' }] : [],
        },
        params: { REGISTER_SONET_EVENT: 'Y' }
      }
    );

    const contactId = contactResp.data.result;
    console.log('Contato criado no Bitrix, ID:', contactId);

    // 3) Criar negócio (deal) no Bitrix
    const dealResp = await axios.post(
      `${BITRIX_WEBHOOK_BASE}/crm.deal.add.json`,
      {
        fields: {
          TITLE: `Pedido Shopify ${orderName}`,
          TYPE_ID: 'GOODS',        // opcional, depende como seu CRM está configurado
          STAGE_ID: 'NEW',         // etapa inicial do funil
          OPPORTUNITY: totalPrice, // valor do pedido
          CURRENCY_ID: currency,
          CONTACT_ID: contactId,
          COMMENTS: `Pedido Shopify:\n${JSON.stringify(order, null, 2)}`
        },
        params: { REGISTER_SONET_EVENT: 'Y' }
      }
    );

    console.log('Negócio criado no Bitrix:', dealResp.data);

    // Resposta pro Shopify
    res.status(200).send('OK');
  } catch (err) {
    console.error('Erro integração Shopify → Bitrix:');
    console.error(err.response?.data || err.message);
    res.status(500).send('Erro');
  }
});

// Sobe o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor ouvindo na porta ${PORT}`);
});
