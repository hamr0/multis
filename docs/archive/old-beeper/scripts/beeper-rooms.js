#!/usr/bin/env node
/**
 * List all rooms with bridge info and recent messages.
 * Helps debug which rooms are WhatsApp, what messages exist, etc.
 */
const { execSync } = require('child_process');

const HOMESERVER = 'https://matrix.beeper.com';
const token = execSync('pass multis/beeper_token', { encoding: 'utf8' }).split('\n')[0].trim();

async function api(endpoint) {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.ok ? res.json() : null;
}

async function main() {
  const { joined_rooms: rooms } = await api('/joined_rooms');
  console.log(`Total rooms: ${rooms.length}\n`);

  for (const roomId of rooms) {
    let name = null;
    let bridgeType = null;
    let bridgeBot = null;
    let members = [];

    // Get room state
    const state = await api(`/rooms/${encodeURIComponent(roomId)}/state`);
    if (state) {
      for (const e of state) {
        if (e.type === 'm.room.name') name = e.content?.name;
        if (e.type === 'com.beeper.bridge_type') bridgeType = e.content?.bridge_type;
        if (e.type === 'm.bridge') {
          const c = e.content || {};
          bridgeBot = c.bridgebot;
          if (!bridgeType) bridgeType = c['com.beeper.bridge_name'] || c.protocol?.id;
        }
        if (e.type === 'm.room.member' && e.content?.membership === 'join' && !e.state_key?.includes(':beeper.')) {
          // Non-bot members
        }
      }
      members = state.filter(e => e.type === 'm.room.member' && e.content?.membership === 'join')
        .map(e => e.content?.displayname || e.state_key);
    }

    // Get last 3 messages
    const msgs = await api(`/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=3`);
    const recent = (msgs?.chunk || []).reverse();

    const label = bridgeType || 'none';
    console.log(`[${label}] ${name || '(unnamed)'} — ${roomId.slice(0, 30)}...`);
    console.log(`  Members: ${members.slice(0, 4).join(', ')}${members.length > 4 ? ` +${members.length - 4}` : ''}`);

    for (const ev of recent) {
      const ts = new Date(ev.origin_server_ts).toISOString().slice(0, 19);
      if (ev.type === 'm.room.encrypted') {
        console.log(`  ${ts} [ENCRYPTED] algo=${ev.content?.algorithm} sender=${ev.sender}`);
      } else if (ev.type === 'm.room.message') {
        const body = (ev.content?.body || '').slice(0, 60);
        console.log(`  ${ts} ${ev.sender}: ${body}`);
      } else {
        console.log(`  ${ts} ${ev.type}`);
      }
    }
    console.log();
  }
}

main().catch(console.error);
