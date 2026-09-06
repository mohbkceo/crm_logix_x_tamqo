import { createContext, useContext } from "react";
import { P, can, hasBusinessAccess } from "../../shared/permissions.js";
export { P, can, hasBusinessAccess };
export const UserContext = createContext(null);
export const useUser = () => useContext(UserContext);
export function Can({ permission, children }) {
  const user = useUser();
  return (Array.isArray(permission) ? permission : [permission]).some((p) =>
    can(user, p),
  )
    ? children
    : null;
}
export function Guard({ permissions, business, children }) {
  const user = useUser();
  return permissions.some((p) => can(user, p)) &&
    (!business || hasBusinessAccess(user, business)) ? (
    children
  ) : (
    <div className="panel modal-body">
      <h2>Access has not been assigned</h2>
      <p>
        Ask your administrator to configure your permissions and business
        access.
      </p>
    </div>
  );
}
