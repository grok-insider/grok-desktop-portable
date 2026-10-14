import { PUBLICATION_ACCOUNT } from "../services/publications";

export function PublicLinks() {
  return <section aria-labelledby="public-links-title" className="flex flex-col gap-3">
    <h2 id="public-links-title" className="font-semibold">Public links</h2>
    <p className="text-body-sm text-muted-foreground">Manage expiry, limits and permanent withdrawal from your Fabrials account, even when your computer is offline.</p>
    <a className="text-body-sm underline" href={PUBLICATION_ACCOUNT} target="_blank" rel="noopener noreferrer">Manage public links on Fabrials</a>
  </section>;
}
