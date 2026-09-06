export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'EMPLOYEE'];
export const BUSINESSES = ['LOGIX', 'TAMQO'];
const groups = {
  orders: ['viewOwn','viewAll','create','updateOwn','updateAll','confirm','prepare','cancel','createShipment','markReady','refreshTracking'],
  analytics: ['viewOwn','viewBusiness','viewGlobal','export'], partnership: ['view'],
  customers: ['view','update'], expenses: ['view','create','update','delete'],
  tamqoPlans: ['view','manage'], logixProducts: ['view','manage'], sources: ['view','manage'], wilayas: ['view','manage'],
  deliveryAgencies: ['view','create','update','disable','delete','assignBusinesses','manageRates','manageCredentials','testConnection'],
  users: ['view','create','update','disable','permissions'], sessions: ['viewOwn','revokeOwn'],
  'users.sessions': ['view','revoke'], audit: ['view'], settings: ['view','manage'], registrationKey: ['manage'],
};
export const P = Object.freeze(Object.fromEntries(Object.entries(groups).map(([resource, actions]) => [resource, Object.freeze(Object.fromEntries(actions.map(action => [action, `${resource}.${action}`])))])));
export const PERMISSIONS = Object.freeze(Object.values(P).flatMap(Object.values));
export const can = (user, permission) => Boolean(user && (user.role === 'SUPER_ADMIN' || user.permissions?.includes(permission)));
export const hasBusinessAccess = (user, business) => Boolean(user && (user.role === 'SUPER_ADMIN' || (business === 'PARTNERSHIP' ? BUSINESSES.every(b => user.businessAccess?.includes(b)) : user.businessAccess?.includes(business))));
