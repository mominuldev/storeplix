// AreaPicker key: "district" for a whole district, "district:thana" for one thana.
export const areaKey = (a: { district_code: string; thana_code?: string | null }) => (a.thana_code ? `${a.district_code}:${a.thana_code}` : a.district_code);
