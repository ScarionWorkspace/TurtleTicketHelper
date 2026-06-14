const appConfig = require('../../config/appConfig');

function getStaffRoleIds() {
    return Array.isArray(appConfig.staffRoleIds)
        ? appConfig.staffRoleIds.filter(Boolean)
        : [];
}

function isStaffMember(member) {
    if (!member?.roles?.cache) {
        return false;
    }

    return getStaffRoleIds().some(roleId => member.roles.cache.has(roleId));
}

module.exports = {
    getStaffRoleIds,
    isStaffMember
};
