const DISCORD_UNKNOWN_MEMBER_CODE = 10007;
const DEFAULT_CONCURRENCY = 5;

function getUniqueDiscordIds(rows) {
    const seen = new Set();
    const ids = [];

    for (const row of Array.isArray(rows) ? rows : []) {
        const discordId = String(row?.discordId || '').trim();

        if (!discordId || seen.has(discordId)) {
            continue;
        }

        seen.add(discordId);
        ids.push(discordId);
    }

    return ids;
}

function isUnknownMemberError(error) {
    return Number(error?.code) === DISCORD_UNKNOWN_MEMBER_CODE;
}

async function fetchDiscordMemberPresence(guild, discordId) {
    if (!guild?.members || typeof guild.members.fetch !== 'function') {
        return null;
    }

    try {
        await guild.members.fetch({
            user: discordId,
            cache: false,
            force: true
        });
        return true;
    } catch (error) {
        if (isUnknownMemberError(error)) {
            return false;
        }

        console.warn('Could not verify Discord guild membership for link list:', {
            discordId,
            errorName: error?.name || null,
            errorMessage: error?.message || null,
            errorCode: error?.code || null,
            status: error?.status || null
        });
        return null;
    }
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const input = Array.isArray(items) ? items : [];
    const limit = Math.max(1, Math.floor(Number(concurrency) || DEFAULT_CONCURRENCY));
    const results = new Array(input.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < input.length) {
            const index = nextIndex;
            nextIndex++;
            results[index] = await mapper(input[index], index);
        }
    }

    await Promise.all(
        Array.from(
            { length: Math.min(limit, input.length) },
            () => worker()
        )
    );

    return results;
}

async function buildDiscordPresenceById(guild, rows, options = {}) {
    const ids = getUniqueDiscordIds(rows);
    const entries = await mapWithConcurrency(
        ids,
        options.concurrency || DEFAULT_CONCURRENCY,
        async discordId => [
            discordId,
            await fetchDiscordMemberPresence(guild, discordId)
        ]
    );

    return entries.reduce((presenceById, [discordId, presence]) => {
        presenceById[discordId] = presence;
        return presenceById;
    }, {});
}

module.exports = {
    DISCORD_UNKNOWN_MEMBER_CODE,
    getUniqueDiscordIds,
    isUnknownMemberError,
    fetchDiscordMemberPresence,
    mapWithConcurrency,
    buildDiscordPresenceById
};
