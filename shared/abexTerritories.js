const territoryName = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function findAbexCommune(communes, value) {
  const key = territoryName(value);
  if (!key) return undefined;
  const exact = communes.filter(
    ({ name, nameArabic }) => name === value || nameArabic === value,
  );
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;

  const matches = communes.filter(
    ({ name, nameArabic }) =>
      territoryName(name) === key || territoryName(nameArabic) === key,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
