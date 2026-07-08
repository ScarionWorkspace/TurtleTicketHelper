const STATUS_MESSAGES = {
    'signed-up': 'You are signed up for this event.',
    'already-signed-up': 'You are already signed up for this event.',
    'accounts-differ-use-update-endpoint': 'You are already signed up with different accounts. Use update accounts to change them.',
    'multiple-linked-accounts': 'Choose which linked account you want to use for this event.',
    'not-linked': 'No linked Clash account was found. Please link or apply with your Clash account first.',
    'player-tag-not-linked': 'That player tag is not linked to your Discord account.',
    'player-tag-outside-event-roster': 'That account is outside the CWL roster for this event.',
    'accounts-outside-event-roster': 'Your linked accounts are outside the CWL roster for this event.',
    'cwl-target-unresolved': 'The CWL event roster is still being resolved. Signups will be available once the target roster is known.',
    'too-many-accounts': 'You selected too many accounts for this event.',
    'duplicate-player-tags': 'The same player tag was selected more than once.',
    'tag-already-assigned': 'One of those player tags is already assigned to another participant.',
    'event-not-found': 'The current event could not be found.',
    'event-not-open': 'This event is not open.',
    'event-closed': 'This event is closed.',
    'signups-closed': 'Signups are closed for this event.',
    updated: 'Your signup was updated.',
    'participant-not-active': 'You do not have an active signup for this event.',
    cancelled: 'Your signup was cancelled.',
    'already-cancelled': 'Your signup was already cancelled.',
    'not-signed-up': 'You are not signed up for this event.'
};

function normalizeResponseStatus(status) {
    return String(status || '')
        .trim()
        .toLowerCase()
        .replace(/_/g, '-');
}

function getStatusMessage(status, fallback = 'The event request completed.') {
    const normalized = normalizeResponseStatus(status);
    return STATUS_MESSAGES[normalized] || fallback;
}

module.exports = {
    STATUS_MESSAGES,
    normalizeResponseStatus,
    getStatusMessage
};
