/**
 * Zustand store for managing contacts / address book.
 * Uses the Database class for persistence.
 */

import { create } from 'zustand';
import { Database, type ContactRow } from '../storage/database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContactsState {
  contacts: ContactRow[];
  loading: boolean;

  /**
   * Clear the in-memory contacts list. Called from `lockWallet` /
   * `switchWallet` / `resetWalletInternals` so data from the previous
   * wallet can't leak to the next one through the shared store (N-11).
   */
  reset: () => void;
  loadContacts: (db: Database) => Promise<void>;
  addContact: (db: Database, name: string, address: string, notes: string) => Promise<void>;
  updateContact: (
    db: Database,
    id: string,
    name: string,
    address: string,
    notes: string,
  ) => Promise<void>;
  deleteContact: (db: Database, id: string) => Promise<void>;
  searchContacts: (db: Database, query: string) => Promise<ContactRow[]>;
  getContactByAddress: (db: Database, address: string) => Promise<ContactRow | null>;
}

// ---------------------------------------------------------------------------
// UUID generator (matches wallet-store pattern)
// ---------------------------------------------------------------------------

function generateContactId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useContactsStore = create<ContactsState>((set, get) => ({
  contacts: [],
  loading: false,

  reset: (): void => {
    set({ contacts: [], loading: false });
  },

  loadContacts: async (db: Database): Promise<void> => {
    set({ loading: true });
    try {
      const contacts = await db.getContacts();
      set({ contacts, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  addContact: async (db: Database, name: string, address: string, notes: string): Promise<void> => {
    const id = generateContactId();
    await db.insertContact(id, name, address, notes);
    await get().loadContacts(db);
  },

  updateContact: async (
    db: Database,
    id: string,
    name: string,
    address: string,
    notes: string,
  ): Promise<void> => {
    await db.updateContact(id, name, address, notes);
    await get().loadContacts(db);
  },

  deleteContact: async (db: Database, id: string): Promise<void> => {
    await db.deleteContact(id);
    await get().loadContacts(db);
  },

  searchContacts: async (db: Database, query: string): Promise<ContactRow[]> => {
    return db.searchContacts(query);
  },

  getContactByAddress: async (db: Database, address: string): Promise<ContactRow | null> => {
    return db.getContactByAddress(address);
  },
}));
