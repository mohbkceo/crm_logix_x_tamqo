export const QUICK_TAGS = [
  { value: "IMPORTANT", label: "Important", category: "priority" },
  { value: "NEW", label: "New", category: "age" },
  { value: "LT4D", label: "< 4 Days", category: "age" },
  { value: "GTE4D", label: "≥ 4 Days", category: "age" },
  { value: "ISSUES", label: "Issues", category: "issue" },
  { value: "BLOCKED", label: "Blocked", category: "issue" },
  { value: "MY_ORDERS", label: "My Orders", category: "assignment" },
  { value: "TODAY", label: "Today", category: "calendar" },
  { value: "NO_ISSUES", label: "No Issues", category: "issue" },
];

export const clearTrackingFilters = () => ({
  view: "custom",
  page: 1,
  limit: 20,
  sort: "oldest",
  lifecycle: "ALL",
  attention: "all",
  tags: "",
});

export function defaultTrackingFilters(user) {
  const base = clearTrackingFilters();
  if (["ADMIN", "SUPER_ADMIN"].includes(user.role)) return base;
  if (user.operationalRoles?.includes("DESIGNER"))
    return {
      ...base,
      stage: "PREPARING",
      lifecycle: "ACTIVE",
      attention: "internal",
    };
  if (
    user.operationalRoles?.some((role) =>
      ["PRODUCTION", "PRODUCTION_MANAGER"].includes(role),
    )
  )
    return {
      ...base,
      stage: "AT_PRODUCTION",
      lifecycle: "ACTIVE",
      attention: "internal",
    };
  if (user.operationalRoles?.includes("SALES_CONFIRMATION"))
    return { ...base, lifecycle: "ACTIVE", sort: "issuesFirst" };
  return base;
}
