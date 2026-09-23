import { useMemo, useState } from "react";
import {
  ArrowDownUp,
  Bell,
  CalendarDays,
  ChevronDown,
  CirclePlus,
  Clock3,
  Ellipsis,
  Filter,
  LayoutGrid,
  ListFilter,
  Mail,
  MapPin,
  MoreHorizontal,
  Phone,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Users,
} from "lucide-react";

type Lead = {
  name: string;
  initials: string;
  color: string;
  source: string;
  when: string;
  phone: string;
  address: string;
  status: "New" | "Following up" | "Scheduled";
  followUp: string;
  value: string;
  priority?: boolean;
};

const leads: Lead[] = [
  { name: "Mara Whitcomb", initials: "MW", color: "#D8E3FF", source: "Facebook Lead Ad", when: "12 min ago", phone: "(512) 555-0189", address: "3402 Ramsey Ave, Austin", status: "New", followUp: "Reply within 18m", value: "$8.4k", priority: true },
  { name: "David N. Chen", initials: "DC", color: "#E8D9F2", source: "Website inquiry", when: "38 min ago", phone: "(512) 555-0112", address: "601 Tillery St, Austin", status: "New", followUp: "Reply within 42m", value: "$3.2k" },
  { name: "Elena Moreno", initials: "EM", color: "#D6EBDD", source: "Google Local Services", when: "Yesterday", phone: "(737) 555-0147", address: "1816 Kinney Ave, Austin", status: "Following up", followUp: "Today, 2:30 PM", value: "$6.1k" },
  { name: "Jordan & Co.", initials: "JC", color: "#F4DFC6", source: "Referral", when: "Yesterday", phone: "(512) 555-0194", address: "1200 E 11th St, Austin", status: "Following up", followUp: "Tomorrow, 9:00 AM", value: "$12.7k" },
  { name: "The Alder House", initials: "AH", color: "#DBE6DD", source: "Website inquiry", when: "Jun 18", phone: "(512) 555-0171", address: "2801 Pearl St, Austin", status: "Scheduled", followUp: "Jun 25, 10:00 AM", value: "$19.5k" },
];

const statusStyle: Record<Lead["status"], string> = {
  New: "bg-[#E7EEFF] text-[#315CAE]",
  "Following up": "bg-[#F8EDCE] text-[#876312]",
  Scheduled: "bg-[#DDEFE4] text-[#27724C]",
};

export default function LeadRefinement() {
  const [activeFilter, setActiveFilter] = useState("My leads");
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");
  const [sortNewest, setSortNewest] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);

  const filteredLeads = useMemo(
    () => leads.filter((lead) => lead.name.toLowerCase().includes(query.toLowerCase()) || lead.source.toLowerCase().includes(query.toLowerCase())),
    [query],
  );

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  };

  const toggle = (name: string) => {
    setSelected((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name]);
  };

  return (
    <main className="min-h-screen bg-[#F5F6F1] text-[#192741]" style={{ fontFamily: "'DM Sans', 'Avenir Next', sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Fraunces:opsz,wght@9..144,600&display=swap');
        .lead-refinement * { box-sizing: border-box; }
        .lead-refinement button { font: inherit; }
        .lead-refinement ::-webkit-scrollbar { width: 7px; }
        .lead-refinement ::-webkit-scrollbar-thumb { background: #d6dbd2; border-radius: 999px; }
        @keyframes rise { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: translateY(0) } }
        .lead-refinement .rise { animation: rise .48s cubic-bezier(.2,.8,.2,1) both; }
      `}</style>
      <div className="lead-refinement flex min-h-screen">
        <aside className="hidden w-[232px] shrink-0 flex-col border-r border-[#DDE2DA] bg-[#EEF0EA] px-4 py-5 md:flex">
          <div className="flex items-center gap-2.5 px-2">
            <div className="grid h-8 w-8 place-items-center rounded-[10px] bg-[#253D77] text-sm font-bold text-[#F6F4EC]">H</div>
            <span className="text-[15px] font-bold tracking-[-.03em]">Hearthline</span>
          </div>
          <div className="mt-8 rounded-xl border border-[#D8DED6] bg-[#F8F9F5] px-3 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-[.14em] text-[#758078]">Workspace</p>
            <button onClick={() => notify("Workspace switcher opened")} className="mt-1 flex w-full items-center justify-between text-left text-[13px] font-semibold">
              Austin operations <ChevronDown size={14} className="text-[#6D7772]" />
            </button>
          </div>
          <nav className="mt-7 space-y-1 text-[13px]">
            <p className="mb-2 px-2 text-[10px] font-bold uppercase tracking-[.15em] text-[#7B847C]">Workspace</p>
            {[
              ["Overview", LayoutGrid],
              ["Leads", Users],
              ["Calendar", CalendarDays],
            ].map(([label, Icon]) => <button key={String(label)} onClick={() => notify(`${label} selected`)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left ${label === "Leads" ? "bg-[#DCE5FF] font-semibold text-[#294D9B]" : "text-[#53605C] hover:bg-[#E5E8E1]"}`}><Icon size={17} strokeWidth={1.8} />{String(label)}</button>)}
            <p className="mb-2 mt-7 px-2 text-[10px] font-bold uppercase tracking-[.15em] text-[#7B847C]">Manage</p>
            {[
              ["Team", Users],
              ["Settings", Settings2],
            ].map(([label, Icon]) => <button key={String(label)} onClick={() => notify(`${label} selected`)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[#53605C] hover:bg-[#E5E8E1]"><Icon size={17} strokeWidth={1.8} />{String(label)}</button>)}
          </nav>
          <div className="mt-auto border-t border-[#D8DED6] pt-4">
            <button onClick={() => notify("Profile menu opened")} className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left hover:bg-[#E5E8E1]">
              <div className="grid h-8 w-8 place-items-center rounded-full bg-[#DCCFE7] text-[11px] font-bold text-[#5C4570]">AN</div>
              <div><p className="text-[12px] font-semibold">Avery Nelson</p><p className="text-[11px] text-[#748078]">Owner</p></div>
              <MoreHorizontal size={15} className="ml-auto text-[#778078]" />
            </button>
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <header className="flex h-[70px] items-center justify-between border-b border-[#E0E3DD] bg-[#F9FAF6] px-5 md:px-9">
            <div className="flex items-center gap-3 text-[12px] text-[#6D7772]"><span>Pipeline</span><span className="text-[#B6BCB4]">/</span><span className="font-medium text-[#33413C]">Leads</span></div>
            <div className="flex items-center gap-2">
              <button onClick={() => notify("No new notifications")} className="relative grid h-9 w-9 place-items-center rounded-lg text-[#596660] hover:bg-[#EEF0EA]"><Bell size={18} /><i className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-[#E56C4E]" /></button>
              <button onClick={() => notify("Create lead form opened")} className="flex items-center gap-2 rounded-lg bg-[#253D77] px-3.5 py-2 text-[12px] font-bold text-[#F7F6F0] shadow-[0_3px_0_#1C2F5D] active:translate-y-px"><CirclePlus size={16} /> New lead</button>
            </div>
          </header>

          <div className="mx-auto max-w-[1320px] px-5 pb-10 pt-7 md:px-9">
            <div className="rise flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.13em] text-[#69836F]"><Sparkles size={13} /> Today&apos;s focus</div>
                <h1 className="text-[34px] leading-none tracking-[-.055em] text-[#182641]" style={{ fontFamily: "'Fraunces', Georgia, serif" }}>Keep the warm ones moving.</h1>
                <p className="mt-3 text-[13px] text-[#65716B]">You have <span className="font-bold text-[#263B59]">2 fresh leads</span> that need a reply before 11:00 AM.</p>
              </div>
              <div className="grid grid-cols-3 overflow-hidden rounded-xl border border-[#DCE1D9] bg-[#FBFCF8]">
                {[["14", "Open leads"], ["4", "Due today"], ["$49.9k", "Pipeline"]].map(([value, label]) => <div key={label} className="min-w-[95px] border-r border-[#E5E8E1] px-4 py-3 last:border-0"><p className="text-[17px] font-bold tracking-[-.04em]">{value}</p><p className="mt-0.5 text-[10px] font-medium text-[#748078]">{label}</p></div>)}
              </div>
            </div>

            <div className="rise mt-7 rounded-2xl border border-[#DAE0D7] bg-[#FCFCF9] shadow-[0_10px_35px_rgba(35,50,45,.045)]" style={{ animationDelay: ".07s" }}>
              <div className="flex flex-col gap-4 border-b border-[#E5E8E1] px-4 py-4 md:px-6 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex gap-1 overflow-x-auto">
                  {["My leads", "All leads", "New", "Following up", "Scheduled"].map((filter) => <button onClick={() => setActiveFilter(filter)} key={filter} className={`whitespace-nowrap rounded-md px-3 py-1.5 text-[12px] font-semibold transition ${activeFilter === filter ? "bg-[#E5EBFA] text-[#294B94]" : "text-[#69756F] hover:bg-[#F1F3EE]"}`}>{filter}{filter === "My leads" && <span className="ml-1.5 rounded-full bg-[#C8D5F5] px-1.5 py-0.5 text-[10px]">8</span>}</button>)}
                </div>
                <button onClick={() => notify("Filter panel opened")} className="flex items-center gap-2 self-start rounded-md border border-[#D8DED6] px-3 py-1.5 text-[12px] font-semibold text-[#53605C] hover:bg-[#F3F5F0]"><SlidersHorizontal size={14} /> Filters <span className="grid h-4 w-4 place-items-center rounded-full bg-[#253D77] text-[9px] text-white">2</span></button>
              </div>
              <div className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between md:px-6">
                <label className="flex h-9 max-w-[365px] flex-1 items-center gap-2 rounded-lg bg-[#F1F3EE] px-3 text-[#718078] focus-within:ring-2 focus-within:ring-[#BDCCF2]"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} className="w-full bg-transparent text-[12px] text-[#24324B] outline-none placeholder:text-[#849089]" placeholder="Search name, source, or phone" /></label>
                <div className="flex items-center gap-2">
                  <button onClick={() => setSortNewest((value) => !value)} className="flex h-9 items-center gap-2 rounded-lg px-2.5 text-[12px] font-medium text-[#60706A] hover:bg-[#F1F3EE]"><ArrowDownUp size={14} /> {sortNewest ? "Newest first" : "Oldest first"}</button>
                  <button onClick={() => notify("Board view selected")} className="grid h-8 w-8 place-items-center rounded-md text-[#77837D] hover:bg-[#EEF1EB]"><LayoutGrid size={16} /></button>
                  <button onClick={() => notify("List view selected")} className="grid h-8 w-8 place-items-center rounded-md bg-[#E7ECFB] text-[#31579F]"><ListFilter size={16} /></button>
                </div>
              </div>
              <div className="hidden grid-cols-[32px_1.4fr_1.15fr_1fr_.75fr_44px] items-center gap-4 border-y border-[#E8EBE5] bg-[#F6F7F3] px-6 py-2 text-[10px] font-bold uppercase tracking-[.1em] text-[#7E8881] md:grid">
                <span></span><span>Lead</span><span>Source</span><span>Next move</span><span>Value</span><span></span>
              </div>
              <div>
                {filteredLeads.map((lead, index) => (
                  <article key={lead.name} className="group grid grid-cols-1 gap-3 border-b border-[#ECEEEA] px-4 py-4 last:border-0 transition hover:bg-[#F8F9F5] md:grid-cols-[32px_1.4fr_1.15fr_1fr_.75fr_44px] md:items-center md:gap-4 md:px-6">
                    <button onClick={() => toggle(lead.name)} aria-label={`Select ${lead.name}`} className={`h-4 w-4 rounded border ${selected.includes(lead.name) ? "border-[#375CA7] bg-[#375CA7]" : "border-[#C7CEC5] bg-white"} text-white`}>{selected.includes(lead.name) && "✓"}</button>
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[11px] font-bold text-[#33425A]" style={{ backgroundColor: lead.color }}>{lead.initials}</div>
                      <div className="min-w-0"><div className="flex items-center gap-2"><p className="truncate text-[13px] font-bold text-[#26354E]">{lead.name}</p>{lead.priority && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#E86D4E]" />}</div><p className="mt-0.5 truncate text-[11px] text-[#77827B]">{lead.phone} <span className="mx-1 text-[#C0C6BE]">·</span>{lead.when}</p></div>
                    </div>
                    <div className="flex min-w-0 items-center gap-2 text-[11px] text-[#66726B]"><span className="h-1.5 w-1.5 rounded-full bg-[#789BDC]" /><span className="truncate">{lead.source}</span></div>
                    <div className="flex flex-col items-start gap-1"><span className={`rounded-full px-2 py-1 text-[10px] font-bold ${statusStyle[lead.status]}`}>{lead.status}</span><span className={`flex items-center gap-1 text-[10px] ${index < 2 ? "font-semibold text-[#B25137]" : "text-[#718078]"}`}><Clock3 size={11} />{lead.followUp}</span></div>
                    <div><p className="text-[13px] font-bold text-[#31435E]">{lead.value}</p><p className="mt-0.5 flex items-center gap-1 text-[10px] text-[#7E8981]"><MapPin size={10} />Austin</p></div>
                    <button onClick={() => notify(`${lead.name} actions opened`)} className="grid h-8 w-8 place-items-center rounded-md text-[#7B867E] opacity-100 hover:bg-[#E9EDE7] md:opacity-0 md:group-hover:opacity-100"><Ellipsis size={17} /></button>
                  </article>
                ))}
                {filteredLeads.length === 0 && <div className="py-16 text-center"><Filter className="mx-auto mb-3 text-[#9CA59F]" size={25} /><p className="text-[13px] font-semibold">No leads match that search</p><button onClick={() => setQuery("")} className="mt-2 text-[12px] font-bold text-[#315AA5]">Clear search</button></div>}
              </div>
              <div className="flex items-center justify-between px-6 py-3 text-[11px] text-[#758078]"><span>Showing {filteredLeads.length} of 14 leads</span><button onClick={() => notify("Next page loaded")} className="rounded-md px-2 py-1 font-semibold text-[#456199] hover:bg-[#E7ECFB]">Next 5 <span className="ml-1">→</span></button></div>
            </div>
          </div>
        </section>
      </div>
      {toast && <div className="fixed bottom-5 right-5 z-10 rounded-lg bg-[#1D304D] px-4 py-3 text-[12px] font-semibold text-[#F9F8F2] shadow-xl">{toast}</div>}
    </main>
  );
}