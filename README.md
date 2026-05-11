TurtleTicketHelper Setup Guide
TurtleTicketHelper renames Ticket Tool channels, handles join clan applications, and posts Clash of Clans player information inside Discord tickets.

Requirements
Before starting, make sure these are ready:

A Discord bot application and bot token.

A Clash of Clans API key.

Ticket Tool installed in your Discord server.

Two Discord categories for tickets:

One category for open tickets.

One category for closed tickets.

Environment Variables
Create a .env file in the project root.

text
DISCORD_BOT_TOKEN=your_discord_bot_token_here
OPEN_TICKET_CATEGORY_ID=your_open_ticket_category_id_here
CLOSED_TICKET_CATEGORY_ID=your_closed_ticket_category_id_here
TICKET_TOOL_BOT_ID=your_ticket_tool_bot_id_here
CLASH_OF_CLANS_API_KEY=your_clash_of_clans_api_key_here
Discord Server Setup
1. Create ticket categories
Create these two categories in your Discord server:

Open Tickets

Closed Tickets

Copy both category IDs and put them into the .env file:

OPEN_TICKET_CATEGORY_ID

CLOSED_TICKET_CATEGORY_ID

To copy an ID, enable Developer Mode in Discord, right-click the category, then click Copy Server ID or Copy ID depending on your client.

2. Get the Ticket Tool Bot ID
Use the Ticket Tool bot ID in:

TICKET_TOOL_BOT_ID

This is required so the bot only reacts to Ticket Tool ticket messages.

3. Configure Ticket Tool dashboard
Open the Ticket Tool dashboard and select the ticket system used by your server.

In the dashboard:

Open the ticket settings.

Select both categories:

Open ticket category

Closed ticket category

Go back to the panel configuration.

Open Panels.

Create 2 panels:

Join Clan

Other Reasons

Attach both panels.

This is needed so TurtleTicketHelper can detect the created tickets and rename them correctly.

Discord Bot Setup
1. Create bot token
In the Discord Developer Portal, open your application, go to Bot, and copy the bot token.

Put it into:

DISCORD_BOT_TOKEN

2. Enable privileged intents
In the Discord Developer Portal under Bot, enable these intents:

Server Members Intent

Message Content Intent

Without these, the bot may not detect ticket information correctly.

3. Bot permissions
Invite the bot with the required permissions.

Recommended permissions:

View Channels

Manage Channels

Send Messages

Read Message History

Depending on your setup, the bot may also need:

Embed Links

Use External Emojis

Attach Files

The most important permissions for this bot are channel access, channel rename support, and message sending inside ticket channels.

Clash of Clans API Setup
Create a Clash of Clans API key and put it into:

CLASH_OF_CLANS_API_KEY

This key is used to fetch player data for the join clan application flow.

Install and Start
Install dependencies:

bash
npm install
Start the bot:

bash
npm start
If everything is correct, the bot should log in and react to Ticket Tool ticket creation and closing events.

Setup Checklist
Discord bot token added to .env

Open ticket category ID added to .env

Closed ticket category ID added to .env

Ticket Tool bot ID added to .env

Clash of Clans API key added to .env

Server Members Intent enabled

Message Content Intent enabled

Ticket Tool configured with both categories

Two panels created: Join Clan and Other Reasons

Bot invited with the required permissions

Example .env
text
DISCORD_BOT_TOKEN=Nz...your_token
OPEN_TICKET_CATEGORY_ID=123456789012345678
CLOSED_TICKET_CATEGORY_ID=234567890123456789
TICKET_TOOL_BOT_ID=557628352828014614
CLASH_OF_CLANS_API_KEY=your_api_key_here
