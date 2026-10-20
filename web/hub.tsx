import { createContext, useContext } from 'react';

export type Company = { id: string; code: string; name: string; legal_name: string | null; details_verified: boolean; support_system_url: string | null; help_contact: string | null; clearance_rule: string; perms: string[]; roles: string[] };
export type Me = {
  person: { id: string; email: string; full_name: string; preferred_name: string | null; photo_path?: string | null; status: string };
  mfaRequired: boolean; superAdmin: boolean; companies: Company[];
  appointments: { id: string; company_id: string; job_title: string; status: string; start_date: string; end_date: string | null; company_name: string; company_code: string; relationship: string }[];
  activeVisit: null | { id: string; started_at: string; expected_end_at: string | null; company_id: string; property_id: string; property_name: string; company_name: string; company_code: string };
  unread: number;
  unreadMessages: number;
  agents: { id: string; name: string; company_name: string; company_code: string }[];
};

export type Hub = {
  me: Me;
  reloadMe: () => Promise<void>;
  company: string; // 'all' or a company id
  setCompany: (c: string) => void;
  can: (perm: string, companyId?: string | null) => boolean; // with no company: in the selected company, or any company in combined view
  co: (id?: string | null) => Company | undefined;
  q: (extra?: Record<string, string | undefined | null>) => string; // query string including the selected company
};
export const HubCtx = createContext<Hub>(null as any);
export const useHub = () => useContext(HubCtx);

export function makeHub(me: Me, company: string, setCompany: (c: string) => void, reloadMe: () => Promise<void>): Hub {
  const co = (id?: string | null) => me.companies.find((c) => c.id === id);
  const can = (perm: string, companyId?: string | null) => {
    const id = companyId ?? (company === 'all' ? null : company);
    return id ? !!co(id)?.perms.includes(perm) : me.companies.some((c) => c.perms.includes(perm));
  };
  const q = (extra: Record<string, string | undefined | null> = {}) => {
    const p = new URLSearchParams();
    if (company !== 'all') p.set('company', company);
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  return { me, reloadMe, company, setCompany, can, co, q };
}
// Admin Centre is shown to anyone holding at least one administrative permission.
export const ADMIN_PERMS = ['company.manage', 'access.manage', 'audit.view', 'staff.create', 'properties.manage', 'appointments.manage', 'training.manage', 'policies.manage', 'performance.manage', 'governance.manage', 'agents.manage', 'finance.manage', 'messaging.configure', 'ai.configure'];
