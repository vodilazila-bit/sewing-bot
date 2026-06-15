const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_CREDS = JSON.parse(process.env.GOOGLE_CREDS);

const app = express();
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const auth = new google.auth.GoogleAuth({
  credentials: GOOGLE_CREDS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function getSheets() {
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

async function appendRow(sheetName, row) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: sheetName + '!A1',
    valueInputOption: 'RAW',
    resource: { values: [row] },
  });
}

async function getRows(sheetName) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: sheetName + '!A1:Z1000',
  });
  return res.data.values || [];
}

async function updateCell(sheetName, row, col, value) {
  const sheets = await getSheets();
  const range = sheetName + '!' + String.fromCharCode(64 + col) + row;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'RAW',
    resource: { values: [[value]] },
  });
}

// Стан користувачів
const userState = {};

function getState(chatId) {
  return userState[chatId] || { state: 'idle', data: {} };
}

function setState(chatId, state, data) {
  userState[chatId] = { state, data: data || {} };
}

function clearState(chatId) {
  delete userState[chatId];
}

function mainMenu(chatId) {
  bot.sendMessage(chatId, '👋 Привіт! Що робимо?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🧵 Додати товар', callback_data: 'add_product' }],
        [{ text: '📝 Подати звіт', callback_data: 'add_report' }],
        [{ text: '📦 Оновити залишки', callback_data: 'update_stock' }],
        [{ text: '👀 Переглянути товари', callback_data: 'view_products' }],
      ],
    },
  });
}

bot.onText(/\/start/, (msg) => {
  clearState(msg.chat.id);
  mainMenu(msg.chat.id);
});

bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const { state, data } = getState(chatId);

  if (state === 'wait_product_name') {
    data.name = text;
    setState(chatId, 'wait_product_category', data);
    bot.sendMessage(chatId, '📂 Обери категорію:', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Сукні', callback_data: 'cat_Сукні' }, { text: 'Блузи', callback_data: 'cat_Блузи' }],
          [{ text: 'Спідниці', callback_data: 'cat_Спідниці' }, { text: 'Штани', callback_data: 'cat_Штани' }],
          [{ text: 'Жакети', callback_data: 'cat_Жакети' }, { text: 'Інше', callback_data: 'cat_Інше' }],
        ],
      },
    });
    return;
  }

  if (state === 'wait_product_price') {
    const price = parseFloat(text);
    if (isNaN(price)) { bot.sendMessage(chatId, '❌ Введи число, наприклад: 850'); return; }
    data.price = price;
    setState(chatId, 'wait_product_sizes', data);
    bot.sendMessage(chatId, '📏 Введи доступні розміри (наприклад: XS, S, M, L, XL):');
    return;
  }

  if (state === 'wait_product_sizes') {
    data.sizes = text;
    setState(chatId, 'wait_product_stock', data);
    bot.sendMessage(chatId, '📦 Скільки штук є на складі?');
    return;
  }

  if (state === 'wait_product_stock') {
    const stock = parseInt(text);
    if (isNaN(stock)) { bot.sendMessage(chatId, '❌ Введи число'); return; }
    data.stock = stock;
    setState(chatId, 'wait_product_days', data);
    bot.sendMessage(chatId, '⏱ Скільки днів іде на пошиття?');
    return;
  }

  if (state === 'wait_product_days') {
    const days = parseInt(text);
    if (isNaN(days)) { bot.sendMessage(chatId, '❌ Введи число'); return; }
    await appendRow('Товари', [data.name, data.category, data.price, data.stock, data.sizes, days, '']);
    clearState(chatId);
    bot.sendMessage(chatId, '✅ Товар додано!\n\n*' + data.name + '*\nКатегорія: ' + data.category + '\nЦіна: ' + data.price + '₴\nРозміри: ' + data.sizes + '\nНа складі: ' + data.stock + ' шт\nПошиття: ' + days + ' дн', { parse_mode: 'Markdown' });
    mainMenu(chatId);
    return;
  }

  if (state === 'wait_report_text') {
    const now = new Date();
    const date = now.toLocaleDateString('uk-UA');
    const time = now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    await appendRow('Звіти швей', [date, time, data.name || msg.from.first_name, text]);
    clearState(chatId);
    bot.sendMessage(chatId, '✅ Звіт прийнято!\n\n📅 ' + date + ' ' + time + '\n👤 ' + (data.name || msg.from.first_name) + '\n📝 ' + text);
    mainMenu(chatId);
    return;
  }

  if (state === 'wait_stock_product') {
    data.productName = text;
    setState(chatId, 'wait_stock_qty', data);
    bot.sendMessage(chatId, '📦 Скільки штук відшили "' + text + '"?');
    return;
  }

  if (state === 'wait_stock_qty') {
    const qty = parseInt(text);
    if (isNaN(qty)) { bot.sendMessage(chatId, '❌ Введи число'); return; }
    const rows = await getRows('Товари');
    let found = false;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] && rows[i][0].toLowerCase().includes(data.productName.toLowerCase())) {
        const newStock = (parseInt(rows[i][3]) || 0) + qty;
        await updateCell('Товари', i + 1, 4, newStock);
        bot.sendMessage(chatId, '✅ Оновлено!\n\n*' + rows[i][0] + '*\nБуло: ' + rows[i][3] + ' шт\nДодали: +' + qty + '\nСтало: ' + newStock + ' шт', { parse_mode: 'Markdown' });
        found = true;
        break;
      }
    }
    if (!found) bot.sendMessage(chatId, '❌ Товар не знайдено.');
    clearState(chatId);
    mainMenu(chatId);
    return;
  }

  mainMenu(chatId);
});

bot.on('callback_query', async (cb) => {
  const chatId = cb.message.chat.id;
  const data_str = cb.data;
  const { state, data } = getState(chatId);
  bot.answerCallbackQuery(cb.id);

  if (data_str === 'add_product') {
    setState(chatId, 'wait_product_name', {});
    bot.sendMessage(chatId, '🧵 Введи *назву товару*:', { parse_mode: 'Markdown' });
    return;
  }
  if (data_str === 'add_report') {
    setState(chatId, 'wait_report_text', { name: cb.from.first_name });
    bot.sendMessage(chatId, '📝 Напиши свій звіт — що відшила сьогодні:');
    return;
  }
  if (data_str === 'update_stock') {
    setState(chatId, 'wait_stock_product', {});
    bot.sendMessage(chatId, '🔍 Напиши назву товару:');
    return;
  }
  if (data_str === 'view_products') {
    const rows = await getRows('Товари');
    if (rows.length <= 1) { bot.sendMessage(chatId, '📦 Товарів ще немає.'); return; }
    let txt = '📦 *Товари на складі:*\n\n';
    rows.slice(1).forEach(r => {
      if (r[0]) txt += (parseInt(r[3]) > 0 ? '🟢' : '🔴') + ' *' + r[0] + '* — ' + (r[3] || 0) + ' шт | ' + (r[2] || 0) + '₴\n';
    });
    bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    return;
  }
  if (data_str.startsWith('cat_') && state === 'wait_product_category') {
    data.category = data_str.replace('cat_', '');
    setState(chatId, 'wait_product_price', data);
    bot.sendMessage(chatId, '✓ Категорія: *' + data.category + '*\n\nВведи *ціну* в гривнях:', { parse_mode: 'Markdown' });
    return;
  }
});

app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(process.env.PORT || 3000);
console.log('Bot started!');
