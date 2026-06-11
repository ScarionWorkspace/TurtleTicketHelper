const path = require('node:path');
const fs = require('node:fs');
const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');
const {
  DISCORD_TOKEN,
  assertBotConfig,
  getConfigWarnings,
  redactKnownSecrets
} = require('./config/env');
const { loadCommands } = require('./utils/loadCommands');

function formatError(error) {
  if (!error) {
    return 'Unknown error';
  }

  const details = {
    name: error.name || null,
    message: error.message || String(error),
    code: error.code || null,
    status: error.status || null
  };

  if (error.stack) {
    details.stack = error.stack;
  }

  return JSON.stringify(details, null, 2);
}

function logError(label, error) {
  console.error(`${label}: ${redactKnownSecrets(formatError(error))}`);
}

function buildEventHandler(event, client) {
  return (...args) => {
    Promise.resolve(event.execute(...args, client)).catch(error => {
      logError(`Discord event "${event.name}" failed`, error);
    });
  };
}

process.on('unhandledRejection', (error) => {
  logError('UNHANDLED REJECTION', error);
});

process.on('uncaughtException', (error) => {
  logError('UNCAUGHT EXCEPTION', error);
  process.exitCode = 1;
});

async function main() {
  assertBotConfig();

  for (const warning of getConfigWarnings()) {
    console.warn(`Config warning: ${warning}`);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel, Partials.Message]
  });

  client.commands = new Collection();

  const commandsPath = path.join(__dirname, 'commands');
  const loadedCommands = loadCommands(commandsPath);

  for (const { command } of loadedCommands) {
    client.commands.set(command.data.name, command);
  }

  console.log(`Loaded ${client.commands.size} slash command handlers.`);

  const eventsPath = path.join(__dirname, 'events');
  const eventFiles = fs
    .readdirSync(eventsPath)
    .filter(file => file.endsWith('.js'));

  for (const file of eventFiles) {
    const event = require(path.join(eventsPath, file));

    if (!event?.name || typeof event.execute !== 'function') {
      console.warn(`Event at ${path.join(eventsPath, file)} is missing "name" or "execute".`);
      continue;
    }

    const handler = buildEventHandler(event, client);

    if (event.once) {
      client.once(event.name, handler);
      continue;
    }

    client.on(event.name, handler);
  }

  client.on('error', error => {
    logError('Discord client error', error);
  });

  client.on('shardError', error => {
    logError('Discord websocket error', error);
  });

  await client.login(DISCORD_TOKEN);
}

main().catch(error => {
  logError('Fatal startup error', error);
  process.exitCode = 1;
});
