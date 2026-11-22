import type { LayoutProps } from '../types';
import type { ModernCommerceSettings } from './schema';
import { Footer } from './footer';
import { Header } from './header';
import { MobileTabBar } from './components/tab-bar';

export function ModernCommerceLayout({ store, settings, navigation, description, contact, social, commerce = null, children }: LayoutProps<ModernCommerceSettings>) {
  return (
    <div className="theme-root flex min-h-dvh flex-col">
      <Header store={store} settings={settings} contact={contact} menu={navigation.main} />
      <main id="main" className="flex-1">
        {children}
      </main>
      <Footer
        store={store}
        settings={settings}
        description={description}
        contact={contact}
        social={social}
        menus={[navigation.footer, navigation.help]}
        paymentMethods={commerce?.payment_methods ?? null}
      />
      <MobileTabBar />
    </div>
  );
}
