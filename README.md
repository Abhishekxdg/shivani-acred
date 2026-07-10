# Shivani — ACRED's digital Chief of Staff & Advisor

An autonomous agent that acts as **ACRED's** chief of staff (runs the operating
rhythm, chases commitments, coordinates the founders) and chief advisor (holds
the company to its charter and protects it from its known failure modes). Brain:
any model on **OpenRouter**. Runs on and fully controls a **GCP Ubuntu VM**.
Interface: **WhatsApp** via [Baileys](https://github.com/WhiskeySockets/Baileys).
Grounded in the full ACRED knowledge base (`knowledge/acred-kb.md`).

> ⚠️ **Shivani has an unrestricted shell on the VM and acts autonomously with no
> confirmation gates.** Only the single controlling number (`OPERATOR_JIDS`) can
> command her. Every action is written to an append-only audit log
> (`data/cos-agent.db` → `audit` table); `!stop` is an instant kill switch that
> also aborts a running command. Run on a VM you are willing to lose.

## Who can control it

`OPERATOR_JIDS` is the allowlist — set to **+91 78994 52307** only. Messages from
any other number get no reply. Operator matching is LID- and device-suffix safe.
Group chats are **not** wired to the agent yet (needs the group JID + a privilege
decision — see "Open items").

## Architecture

```
WhatsApp (Baileys)  ─►  handlers ─►  agent core ─►  OpenRouter (LLM brain)
      ▲                    │            │  ▲              │
      └──── replies ───────┘            │  └── tool results
       + proactive sends                ▼
        (polls/docs/…)         tools: shell · fs · process · schedule
                                     · whatsapp send · commitments · memory
                                        │
                                        ▼
                    GCP Ubuntu VM  +  SQLite (history/audit/schedules/commitments)
                                        ▲
                                        │  cron
                                   scheduler (4-hourly check-in, weekly digest)
```

| Piece | File |
|---|---|
| Entry / boot / cadence | `src/index.ts` |
| Config, operator + founder resolution | `src/config.ts` |
| Persona = Shivani's mandate + KB loader | `src/agent/personas.ts` |
| Knowledge base | `knowledge/acred-kb.md` |
| Agent loop (LLM ↔ tools) | `src/agent/core.ts` |
| WhatsApp connect + rich send | `src/whatsapp/gateway.ts` |
| Operator/JID matching, message unwrap | `src/whatsapp/jid.ts` |
| Name→JID targeting | `src/whatsapp/targets.ts` |
| Tools | `src/agent/tools/*.ts` |
| State (history/audit/schedules/commitments) | `src/store/db.ts` |
| Persistent scheduler | `src/scheduler/scheduler.ts` |
| Kill switch (with command abort) | `src/control/killswitch.ts` |
| Audit (secret-redacted logs) | `src/control/audit.ts` |

## Tools Shivani has

- **VM:** `shell`, `read_file`, `write_file`, `list_dir`, `make_dir`, `remove_path`, `spawn_background`, `kill_process`
- **WhatsApp:** `send_message`, `send_poll`, `send_document`, `send_image`, `send_location` (target by `"me"`/`"ceo"`/`"group"`/founder name/number)
- **Coordination:** `log_commitment`, `list_commitments`, `close_commitment`
- **Cadence & memory:** `schedule_task`, `list_schedules`, `cancel_schedule`, `remember`, `recall`

## Quick start (local)

```bash
npm install
# .env is already seeded with the operator number + identity.
# Edit .env: set OPENROUTER_API_KEY (required), add founder numbers, group JID.
npm run dev               # first run prints a WhatsApp QR — scan via Linked Devices
```

Then message from **+91 78994 52307**: `!help`, `!status`, or
*"Draft the ELINA weekly numbers and send them to me."*

## Operator commands (WhatsApp)

| Command | Effect |
|---|---|
| `!help` | Help |
| `!status` | Agent, model, kill-switch state |
| `!stop` / `!kill` | Emergency stop — halt actions, abort running command |
| `!resume` | Reactivate |

Everything else is an instruction to Shivani.

## Proactive rhythm (off by default)

Set `ENABLE_CADENCE=true` (after founder numbers/group are in `.env`) to enable:
- **4-hourly founder check-ins** (`CHECKIN_CRON`, default 09/13/17/21)
- **Weekly CEO digest** of open commitments (`DIGEST_CRON`, default Fri 18:00)

Schedules persist in SQLite and reload on restart.

## Deploy to GCP Ubuntu

```bash
bash deploy/setup-gcp-ubuntu.sh   # Node 20 + build tools, prints next steps
```
Scan the QR once interactively (`npm start`), then run as a systemd service —
see `deploy/cos-agent.service`.

## Configuration (`.env`)

See `.env.example`. Key fields: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`,
`OPERATOR_JIDS`, `FOUNDERS` (`Name:number,…`), `FOUNDERS_GROUP_JID`, `CEO_JID`,
`ENABLE_CADENCE`, `CHECKIN_CRON`, `DIGEST_CRON`, `TZ` (default `Asia/Kolkata`).

## Open items

- Founder numbers for Charu, Prajwal, and the Ops/Finance founder (`FOUNDERS`).
- Founders' group JID + a decision on **group privileges** (recommended:
  coordination-only in the group; destructive VM tools remain operator-DM only).
- Real `OPENROUTER_API_KEY`.
- Detailed behavior/workflow spec layers onto this foundation.
