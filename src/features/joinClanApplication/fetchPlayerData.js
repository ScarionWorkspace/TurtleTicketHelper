const { COC_API_TOKEN } = require('../../config/env');

const VALID_TAG_CHARS = /^[#PYLQGRJCUV0289]+$/i;

function normalizePlayerTag(tag) {
    let cleaned = String(tag || '').trim().toUpperCase().replace(/\s+/g, '');

    if (!cleaned.startsWith('#')) {
        cleaned = `#${cleaned}`;
    }

    cleaned = cleaned.replace(/O/g, '0');

    return cleaned;
}

function isValidPlayerTag(tag) {
    return VALID_TAG_CHARS.test(tag);
}

async function fetchPlayerData(playerTag) {
    if (!COC_API_TOKEN) {
        throw new Error('COC_API_TOKEN is missing in .env');
    }

    console.log('raw tag:', playerTag);

    const normalizedTag = normalizePlayerTag(playerTag);
    const encodedTag = encodeURIComponent(normalizedTag);
    const url = `https://api.clashofclans.com/v1/players/${encodedTag}`;

    console.log('normalized tag:', normalizedTag);
    console.log('encoded tag:', encodedTag);
    console.log('url:', url);

    if (!isValidPlayerTag(normalizedTag)) {
        throw new Error('INVALID_PLAYER_TAG');
    }

    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${COC_API_TOKEN}`,
            Accept: 'application/json'
        }
    });

    if (!response.ok) {
        const errorText = await response.text();

        if (response.status === 404) {
            throw new Error('PLAYER_NOT_FOUND');
        }

        throw new Error(`Clash API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    console.log('player debug:', {
        tag: data.tag,
        name: data.name,
        townHallLevel: data.townHallLevel,
        expLevel: data.expLevel,
        trophies: data.trophies,
        bestTrophies: data.bestTrophies,
        warStars: data.warStars,
        attackWins: data.attackWins,
        defenseWins: data.defenseWins,
        donations: data.donations,
        donationsReceived: data.donationsReceived,
        clan: data.clan,
        leagueTier: data.leagueTier
    });

    return {
        tag: data.tag || normalizedTag,
        name: data.name || 'Unknown',
        townHallLevel: data.townHallLevel ?? 'Unknown',
        expLevel: data.expLevel ?? 'Unknown',
        trophies: data.trophies ?? 'Unknown',
        bestTrophies: data.bestTrophies ?? 'Unknown',
        warStars: data.warStars ?? 'Unknown',
        attackWins: data.attackWins ?? 'Unknown',
        defenseWins: data.defenseWins ?? 'Unknown',
        donations: data.donations ?? 'Unknown',
        donationsReceived: data.donationsReceived ?? 'Unknown',
        clanName: data.clan?.name || 'No Clan',
        clanTag: data.clan?.tag || null,
        currentLeague: data.leagueTier?.name || 'Unknown',
        currentLeagueIcon: data.leagueTier?.iconUrls?.large || null
    };
}

module.exports = {
    fetchPlayerData,
    normalizePlayerTag,
    isValidPlayerTag
};