// Every user-visible string of the hosted checkout, the embedded checkout and
// the hosted invoice and portal pages, in every language Peable's payer
// surfaces speak (`CHECKOUT_LOCALES`, the same set as the Pay with Peable sheet
// and the customer emails). `locales/en.ts` is the source: its keys are the
// message set, and `CATALOGS` is typed over `CheckoutLocale`, so a language
// added to the set is a compile error here until it is translated.
//
// One catalog per SURFACE, not one shared with the sheet: the strings differ,
// and the sheet ships in apps whose bundler (Metro) does not tree-shake, so a
// merged catalog would ship this page's copy inside every Oxy app.
import type { CheckoutLocale } from '@peable.to/shared-types';
import ar from './locales/ar';
import bn from './locales/bn';
import ca from './locales/ca';
import de from './locales/de';
import en, { type Messages } from './locales/en';
import es from './locales/es';
import fr from './locales/fr';
import hi from './locales/hi';
import id from './locales/id';
import it from './locales/it';
import ja from './locales/ja';
import pt from './locales/pt';
import ru from './locales/ru';
import tr from './locales/tr';
import zh from './locales/zh';

export type { MessageKey, Messages } from './locales/en';

export const CATALOGS: Readonly<Record<CheckoutLocale, Messages>> = Object.freeze({
  ar,
  bn,
  ca,
  de,
  en,
  es,
  fr,
  hi,
  id,
  it,
  ja,
  pt,
  ru,
  tr,
  zh,
});
