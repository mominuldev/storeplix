import type { LayoutProps } from '../types';
import type { ModernCommerceSettings } from './schema';
import { Footer } from './footer';
import { Header } from './header';

export function ModernCommerceLayout({ store, settings, description, contact, social, children }: LayoutProps<ModernCommerceSettings>) {
  return (
    <div className="theme-root flex min-h-dvh flex-col">
      <Header store={store} settings={settings} contact={contact} />
      <main id="main" className="flex-1">
        {children}
      </main>
      <Footer store={store} settings={settings} description={description} contact={contact} social={social} />
    </div>
  );
}
