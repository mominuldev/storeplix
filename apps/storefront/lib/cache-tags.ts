/** Cache tag for everything rendered for one storefront host. Laravel revalidates it on publish. */
export const storeTag = (host: string) => `store:${host}`;
