const appConfig = require('../../config/appConfig');

function getSeasonEventAdminRoleIds() {
    const configuredIds = appConfig.seasonEvents?.adminRoleIds;

    if (Array.isArray(configuredIds) && configuredIds.length > 0) {
        return configuredIds;
    }

    return appConfig.staffRoleIds || [];
}

function isSeasonEventAdmin(member) {
    if (!member?.roles?.cache) {
        return false;
    }

    return getSeasonEventAdminRoleIds().some(roleId => member.roles.cache.has(roleId));
}

module.exports = {
    getSeasonEventAdminRoleIds,
    isSeasonEventAdmin
};
