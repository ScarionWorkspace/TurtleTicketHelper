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

function canTakeAnyWarFollowupCase(member) {
    if (!member?.roles?.cache) return false;
    const roleIds = Array.isArray(appConfig.warFollowup?.unrestrictedOwnershipRoleIds)
        ? appConfig.warFollowup.unrestrictedOwnershipRoleIds.filter(Boolean)
        : [];
    return roleIds.some(roleId => member.roles.cache.has(roleId));
}

module.exports = {
    getStaffRoleIds,
    isStaffMember,
    canTakeAnyWarFollowupCase
};
