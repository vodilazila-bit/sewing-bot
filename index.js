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

async function getRows(sheetName) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: sheetName + '!A1:Z1000',
  });
  return res.data.values || [];
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

const CATEGORIES = ['Сукня', 'Панама', 'Шапка', 'Пов\'язка', 'Бодік'];

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
        [{ text: '👀 Переглянути залишки', callback_data: 'view_products' }],
      ],
    },
  });
}

function sendCategories(chatId) {
  bot.sendMessage(chatId, '📂 Обери категорію:', {
    reply_markup: {
      inline_keyboard: CATEGORIES.map(c => [{ text: c, callback_data: 'cat_' + c }])
    }
  });
}

function sendColors(chatId) {
  bot.sendMessage(chatId, '🎨 Обери колір:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Білий', callback_data: 'col_Білий' }, { text: 'Чорний', callback_data: 'col_Чорний' }],
        [{ text: 'Бежевий', callback_data: 'col_Бежевий' }, { text: 'Рожевий', callback_data: 'col_Рожевий' }],
        [{ text: 'Блакитний', callback_data: 'col_Блакитний' }, { text: 'Зелений', callback_data: 'col_Зелений' }],
        [{ text: '✏️ Інший (вписати)', callback_data: 'col_custom' }],
      ]
    }
  });
}

function sendSizes(chatId) {
  bot.sendMessage(chatId, '📏 Обери розмір:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'XS', callback_data: 'sz_XS' }, { text: 'S', callback_data: 'sz_S' }, { text: 'M', callback_data: 'sz_M' }],
        [{ text: 'L', callback_data: 'sz_L' }, { text: 'XL', callback_data: 'sz_XL' }, { text: 'XXL', callback_data: 'sz_XXL' }],
        [{ text: 'Без розміру', callback_data: 'sz_Без розміру' }],
      ]
    }
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

  if (state === 'wait_color_custom') {
    data.color = text;
    setState(chatId, 'wait_size', data);
    sendSizes(chatId);
    return;
  }

  if (state === 'wait_qty') {
    const qty = parseInt(text);
    if (isNaN(qty) || qty < 1) { bot.sendMessage(chatId, '❌ Введи ціле число більше 0'); return; }
    data.qty = qty;
    try {
      const rows = await getRows('Sheet1');
      let found = false;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] === data.category && rows[i][1] === data.color && rows[i][2] === data.size) {
          const newQty = (parseInt(rows[i][3]) || 0) + qty;
          await updateCell('Sheet1', i + 1, 4, newQty);
          bot.sendMessage(chatId, '✅ Оновлено!\n\n*' + data.category + '* · ' + data.color + ' · ' + data.size + '\nБуло: ' + rows[i][3] + ' шт → Стало: *' + newQty + ' шт*', { parse_mode: 'Markdown' });
          found = true;
          break;
        }
      }
      if (!found) {
        await appendRow('Sheet1', [data.category, data.color, data.size, qty]);
        bot.sendMessage(chatId, '✅ Товар додано!\n\n*' + data.category + '* · ' + data.color + ' · ' + data.size + '\nКількість: *' + qty + ' шт*', { parse_mode: 'Markdown' });
      }
    } catch(e) { bot.sendMessage(chatId, '❌ Помилка: ' + e.message); }
    clearState(chatId);
    mainMenu(chatId);
    return;
  }

  if (state === 'wait_report_text') {
    const now = new Date();
    const date = now.toLocaleDateString('uk-UA');
    const time = now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    try {
      await appendRow('Звіти', [date, time, data.name || msg.from.first_name, text]);
      bot.sendMessage(chatId, '✅ Звіт прийнято!\n\n📅 ' + date + ' ' + time + '\n👤 ' + (data.name || msg.from.first_name) + '\n📝 ' + text);
    } catch(e) { bot.sendMessage(chatId, '❌ Помилка: ' + e.message); }
    clearState(chatId);
    mainMenu(chatId);
    return;
  }

  mainMenu(chatId);
});

bot.on('callback_query', async (cb) => {
  const chatId = cb.message.chat.id;
  const d = cb.data;
  const { state, data } = getState(chatId);
  bot.answerCallbackQuery(cb.id);

  if (d === 'add_product') { setState(chatId, 'wait_category', {}); sendCategories(chatId); return; }
  if (d === 'add_report') { setState(chatId, 'wait_report_text', { name: cb.from.first_name }); bot.sendMessage(chatId, '📝 Напиши звіт — що відшила сьогодні:'); return; }

  if (d === 'view_products') {
    try {
      const rows = await getRows('Sheet1');
      if (rows.length <= 1) { bot.sendMessage(chatId, '📦 Склад порожній.'); return; }
      let txt = '📦 *Залишки на складі:*\n\n';
      rows.slice(1).forEach(r => {
        if (r[0]) {
          const qty = parseInt(r[3]) || 0;
          txt += (qty > 0 ? '🟢' : '🔴') + ' *' + r[0] + '* · ' + (r[1]||'') + ' · ' + (r[2]||'') + ' — *' + qty + ' шт*\n';
        }
      });
      bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    } catch(e) { bot.sendMessage(chatId, '❌ Помилка: ' + e.message); }
    return;
  }

  if (d.startsWith('cat_') && state === 'wait_category') {
    data.category = d.replace('cat_', '');
    setState(chatId, 'wait_color', data);
    sendColors(chatId);
    return;
  }

  if (d.startsWith('col_') && state === 'wait_color') {
    if (d === 'col_custom') {
      setState(chatId, 'wait_color_custom', data);
      bot.sendMessage(chatId, '✏️ Напиши колір:');
    } else {
      data.color = d.replace('col_', '');
      setState(chatId, 'wait_size', data);
      sendSizes(chatId);
    }
    return;
  }

  if (d.startsWith('sz_') && state === 'wait_size') {
    data.size = d.replace('sz_', '');
    setState(chatId, 'wait_qty', data);
    bot.sendMessage(chatId, '✓ *' + data.category + '* · ' + data.color + ' · ' + data.size + '\n\nСкільки штук?', { parse_mode: 'Markdown' });
    return;
  }
});

app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(process.env.PORT || 3000);
console.log('Bot started!');
