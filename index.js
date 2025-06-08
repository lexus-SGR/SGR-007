require('dotenv').config()
const express = require('express')
const path = require('path')
const fs = require('fs')
const app = express()
const { Boom } = require('@hapi/boom')
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  jidDecode,
  getContentType
} = require('@whiskeysockets/baileys')
const pino = require('pino')

const PORT = process.env.PORT || 3000
const OWNER_PHONE = process.env.OWNER_PHONE || '255760317060'
const PREFIX = process.env.PREFIX || 'B'
const SESSION_DIR = path.join(__dirname, 'sessions')
const COMMANDS_DIR = path.join(__dirname, 'commands')
const PUBLIC_DIR = path.join(__dirname, 'public')
const sessionPath = path.join(SESSION_DIR, OWNER_PHONE)

app.use(express.static(PUBLIC_DIR))

let pairingCode = null

app.get('/', (req, res) => {
  res.send(`
  <html>
    <head><title>Pairing Code</title>
      <style>
        body {
          background: url("/cyber-md.jpg") no-repeat center center fixed;
          background-size: cover;
          font-family: sans-serif;
          color: #00ffcc;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          margin: 0;
        }
        .box {
          background: rgba(0,0,0,0.7);
          padding: 40px;
          border-radius: 12px;
          text-align: center;
        }
        h1 { font-size: 2em; }
        .code {
          font-size: 2.5em;
          font-weight: bold;
          margin-top: 10px;
        }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>Your Pairing Code</h1>
        <div class="code">${pairingCode || "Loading..."}</div>
      </div>
    </body>
  </html>
  `)
})

async function loadCommands() {
  const commands = {}
  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.js'))
  for (const file of files) {
    const cmd = require(path.join(COMMANDS_DIR, file))
    if (cmd.name && cmd.execute) {
      commands[cmd.name] = cmd
      console.log(`✅ Loaded: ${cmd.name}`)
    }
  }
  return commands
}

async function startBot() {
  const { version } = await fetchLatestBaileysVersion()
  console.log(`Using Baileys v${version.join('.')}`)

  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    syncFullHistory: false,
  })

  sock.ev.on('creds.update', saveCreds)

  if (!state.creds.registered) {
    pairingCode = await sock.requestPairingCode(OWNER_PHONE)
    console.log(`📲 Pairing code: ${pairingCode}`)
  }

  const commands = await loadCommands()

  // Auto View Status
  sock.ev.on('messages.update', async updates => {
    for (let update of updates) {
      if (update.messageStubType === 0 && update.key?.remoteJid?.includes('status@broadcast')) {
        await sock.readMessages([update.key])
      }
    }
  })

  // Auto Open View Once
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (let msg of messages) {
      if (!msg.message || msg.key.fromMe) continue
      const content = Object.values(msg.message)[0]
      if (content?.viewOnce) {
        const media = Object.values(content)[0]
        await sock.sendMessage(msg.key.remoteJid, {
          text: `🔓 ViewOnce opened by bot`,
          contextInfo: { forwardingScore: 999, isForwarded: true }
        })
        await sock.sendMessage(msg.key.remoteJid, media)
      }

      // Antilink
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ''
      if (text.match(/chat\.whatsapp\.com\/[A-Za-z0-9]{20,24}/)) {
        if (!msg.key.fromMe) {
          await sock.sendMessage(msg.key.remoteJid, { text: '🚫 No Group Links Allowed!' })
          await sock.groupParticipantsUpdate(msg.key.remoteJid, [msg.key.participant], 'remove')
        }
      }

      // Command Handler
      if (text.startsWith(PREFIX)) {
        const args = text.slice(PREFIX.length).trim().split(/ +/)
        const name = args.shift().toLowerCase()
        if (commands[name]) {
          try {
            await commands[name].execute(sock, msg, args)
          } catch (err) {
            console.error(`❌ Error in ${name}:`, err)
          }
        }
      }
    }
  })

  // Welcome + Goodbye
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    for (let user of participants) {
      if (action === 'add') {
        await sock.sendMessage(id, {
          text: `👋 Karibu @${user.split('@')[0]}!\n📜 Rules:\n1. Usitume link\n2. Heshimu kila mtu`,
          mentions: [user]
        })
      }
      if (action === 'remove') {
        await sock.sendMessage(id, {
          text: `👋 Kwa heri @${user.split('@')[0]}`,
          mentions: [user]
        })
      }
    }
  })

  console.log('✅ Bot is running...')
}

app.listen(PORT, () => {
  console.log(`🌐 Web Server running on http://localhost:${PORT}`)
  startBot().catch(console.error)
})
