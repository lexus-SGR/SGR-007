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
    <head>
      <title>Pairing Code</title>
      <link rel="icon" type="image/png" href="/cyber.png" />
      <style>
        body {
          background: url("/cyber.png") no-repeat center center fixed;
          background-size: cover;
          font-family: 'Segoe UI', sans-serif;
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
          box-shadow: 0 0 20px #00ffcc;
          animation: glow 2s infinite alternate;
        }
        h1 {
          font-size: 2.2em;
          margin-bottom: 20px;
        }
        .code {
          font-size: 2.8em;
          font-weight: bold;
          color: #ffffff;
          text-shadow: 0 0 10px #00ffcc;
          user-select: text;
          margin-bottom: 20px;
        }
        button.copy-btn {
          background-color: #00ffcc;
          border: none;
          color: #000;
          font-weight: bold;
          padding: 10px 20px;
          border-radius: 8px;
          cursor: pointer;
          transition: background-color 0.3s ease;
        }
        button.copy-btn:hover {
          background-color: #00cc99;
        }
        footer {
          margin-top: 30px;
          color: #00ffcc;
          font-size: 1em;
          text-align: center;
          font-family: monospace;
        }
        @keyframes glow {
          from {
            box-shadow: 0 0 10px #00ffcc;
          }
          to {
            box-shadow: 0 0 30px #00ffcc, 0 0 60px #00ffcc;
          }
        }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>Your Pairing Code</h1>
        <div id="code" class="code">${pairingCode || "Loading..."}</div>
        <button class="copy-btn" onclick="copyCode()">Copy Pairing Code</button>
      </div>
      <footer>
        Repo: <a href="https://github.com/lexus-SGR/SGR-007.git" target="_blank" style="color:#00ffcc; text-decoration:none;">BEN-WHITTAKER-TECH-BOT</a> | Owner: +${OWNER_PHONE}
      </footer>
      <script>
        function copyCode() {
          const codeText = document.getElementById('code').textContent;
          navigator.clipboard.writeText(codeText).then(() => {
            alert('Pairing code copied to clipboard!');
          }).catch(() => {
            alert('Failed to copy pairing code.');
          });
        }
      </script>
    </body>
  </html>
  `)
})

async function loadCommands() {
  const commands = {}
  if (!fs.existsSync(COMMANDS_DIR)) return commands
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
  console.log(`📦 Using Baileys v${version.join('.')}`)

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
    console.log(`🔑 Pairing code: ${pairingCode}`)
  }

  const commands = await loadCommands()

  sock.ev.on('messages.update', async updates => {
    for (let update of updates) {
      if (update.messageStubType === 0 && update.key?.remoteJid?.includes('status@broadcast')) {
        await sock.readMessages([update.key])
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (let msg of messages) {
      if (!msg.message || msg.key.fromMe) continue

      const content = Object.values(msg.message)[0]
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''

      // Open ViewOnce
      if (content?.viewOnce) {
        const media = Object.values(content)[0]
        await sock.sendMessage(msg.key.remoteJid, {
          text: `🔓 ViewOnce opened by bot`,
          contextInfo: { forwardingScore: 999, isForwarded: true }
        })
        await sock.sendMessage(msg.key.remoteJid, media)
      }

      // Antilink
      const isGroupLink = /chat\.whatsapp\.com\/[A-Za-z0-9]{20,24}/.test(text)
      if (isGroupLink && !msg.key.fromMe) {
        await sock.sendMessage(msg.key.remoteJid, { text: '🚫 No Group Links Allowed!' })
        await sock.groupParticipantsUpdate(msg.key.remoteJid, [msg.key.participant], 'remove')
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

  // Welcome / Goodbye
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    for (let user of participants) {
      if (action === 'add') {
        await sock.sendMessage(id, {
          text: `👋 Karibu @${user.split('@')[0]}!\n📜 Rules:\n1. Usitume link\n2. Heshimu kila mtu`,
          mentions: [user]
        })
      } else if (action === 'remove') {
        await sock.sendMessage(id, {
          text: `👋 Kwa heri @${user.split('@')[0]}`,
          mentions: [user]
        })
      }
    }
  })

  console.log('✅ WhatsApp bot is running...')
}

app.listen(PORT, () => {
  console.log(`🌐 Web server running at http://localhost:${PORT}`)
  startBot().catch(console.error)
})
