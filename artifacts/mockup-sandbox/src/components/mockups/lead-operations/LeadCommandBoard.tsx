import { useMemo, useState } from "react";
import {
  Archive,
  CalendarDays,
  Check,
  ChevronDown,
  CirclePlus,
  Clock3,
  Ellipsis,
  Filter,
  LayoutGrid,
  ListFilter,
  Mail,
  MapPin,
  Phone,
  Search,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";

type Lead = {
  id: number;
  name: string;
  initials: string;
  tone: string;
  status: "New" | "Following up" | "Scheduled";
  source: string;
  time: string;
  phone: string;
  email: string;
  address: string;
  note?: string;
  task?: string;
};

const leads: Lead[] = [
  {
    id: 1,
    name: "Maya Hart",
    initials: "MH",
    tone: "#DCE9E1",
    status: "New",
    source: "Facebook lead ad",
    time: "8 min ago",
    phone: "(415) 555-0184",
    email: "maya.hart@email.com",
    address: "1143 Valencia St, San Francisco",
    note: "Asked about a same-week estimate for ductless installation.",
    task: "Call before 10:30 AM",
  },
  {
    id: 2,
    name: "Nolan Reyes",
    initials: "NR",
    tone: "#F3E1CD",
    status: "Following up",
    source: "Website request",
    time: "42 min ago",
    phone: "(415) 555-0127",
    email: "nolan.reyes@email.com",
    address: "2380 18th St, San Francisco",
    task: "Follow up Friday",
  },
  {
    id: 3,
    name: "Priya Shah",
    initials: "PS",
    tone: "#E6DCF2",
    status: "Scheduled",
    source: "Referral",
    time: "Yesterday",
    phone: "(415) 555-0192",
    email: "priya.shah@email.com",
    address: "701 Corbett Ave, San Francisco",
    task: "Visit Thu, 1:00 PM",
  },
  {
    id: 4,
    name: "Theo Bennett",
    initials: "TB",
    tone: "#D9E8F3",
    status: "New",
    source: "Google Local",
    time: "Yesterday",
    phone: "(415) 555-0165",
    email: "theo.bennett@email.com",
    address: "88 Townsend St, San Francisco",
  },
];

const statusStyles = {
  New: { dot: "#EB7E3C", bg: "#FEF0E5", color: "#A54B19" },
  "Following up": { dot: "#507DCB", bg: "#E9F0FF", color: "#315EAA" },
  Scheduled: { dot: "#4E9B78", bg: "#E4F3EB", color: "#237052" },
};

export function LeadCommandBoard() {
  const [active, setActive] = useState("All");
  const [selected, setSelected] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [dense, setDense] = useState(false);
  const [toast, setToast] = useState("");

  const visibleLeads = useMemo(
    () =>
      leads.filter((lead) => {
        const statusMatch = active === "All" || lead.status === active;
        const searchMatch = `${lead.name} ${lead.email} ${lead.address}`.toLowerCase().includes(search.toLowerCase());
        return statusMatch && searchMatch;
      }),
    [active, search],
  );

  const toggleLead = (id: number) => {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const sendAction = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  };

  return (
    <main
      className="min-h-screen overflow-hidden px-4 py-5 sm:px-7 sm:py-7"
      style={{
        background: "#F4F5F0",
        color: "#24302B",
        fontFamily: '"DM Sans", "Avenir Next", sans-serif',
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Fraunces:opsz,wght@9..144,600&display=swap');
        .lcb-fraunces { font-family: "Fraunces", Georgia, serif; }
        .lcb-mono { font-family: "DM Mono", monospace; }
        .lcb-card { transition: transform 180ms ease, box-shadow 180ms ease; }
        .lcb-card:hover { transform: translateY(-2px); box-shadow: 0 16px 30px rgba(35,48,43,.09); }
        .lcb-reveal { animation: lcbReveal .45s both; }
        @keyframes lcbReveal { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: translateY(0) } }
      `}</style>

      <div className="mx-auto max-w-[1440px]">
        <header className="mb-7 flex flex-col gap-5 border-b border-[#D9DED5] pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex items-start gap-3">
            <div className="mt-1 flex h-9 w-9 items-center justify-center rounded-xl bg-[#253D35] text-[#F5F3EC]">
              <Sparkles size={17} strokeWidth={1.8} />
            </div>
            <div>
              <p className="lcb-mono mb-1 text-[10px] font-medium uppercase tracking-[.15em] text-[#6E7870]">Fieldbook / Sales desk</p>
              <h1 className="lcb-fraunces text-3xl leading-none tracking-[-.04em] text-[#20332B] sm:text-[38px]">Leads</h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => sendAction("Archive opened")} className="flex h-10 items-center gap-2 rounded-lg border border-[#CFD7CD] bg-[#FAFBF7] px-3.5 text-sm font-medium text-[#46544D]">
              <Archive size={15} /> <span>Archive</span>
            </button>
            <button onClick={() => setShowNew(true)} className="flex h-10 items-center gap-2 rounded-lg bg-[#E57735] px-4 text-sm font-semibold text-[#FFFCF5] shadow-[0_4px_0_#C45E25] transition-transform active:translate-y-[2px]">
              <CirclePlus size={16} /> Add lead
            </button>
          </div>
        </header>

        <section className="lcb-reveal grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="min-w-0">
            <div className="mb-5 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex min-w-0 gap-1 overflow-x-auto border-b border-[#D7DCD3]">
                {[
                  ["All", "24"],
                  ["New", "08"],
                  ["Following up", "11"],
                  ["Scheduled", "05"],
                ].map(([label, count]) => (
                  <button
                    key={label}
                    onClick={() => setActive(label)}
                    className="relative whitespace-nowrap px-3 py-2.5 text-sm font-medium"
                    style={{ color: active === label ? "#203B32" : "#707B73" }}
                  >
                    {label}
                    <span className="lcb-mono ml-1.5 text-[10px] opacity-70">{count}</span>
                    {active === label && <span className="absolute inset-x-2 bottom-0 h-0.5 bg-[#DF7034]" />}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <label className="flex h-9 min-w-[190px] flex-1 items-center gap-2 rounded-lg border border-[#D5DBD1] bg-[#FAFBF7] px-3 text-[#768177] xl:w-[245px]">
                  <Search size={15} />
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search leads" className="min-w-0 flex-1 bg-transparent text-sm text-[#2B3932] outline-none placeholder:text-[#8B958D]" />
                </label>
                <button onClick={() => sendAction("Advanced filters ready")} className="flex h-9 items-center gap-2 rounded-lg border border-[#D5DBD1] bg-[#FAFBF7] px-3 text-sm font-medium text-[#536159]">
                  <SlidersHorizontal size={15} /> <span className="hidden sm:inline">Filter</span>
                </button>
                <button onClick={() => setDense(!dense)} className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#D5DBD1] bg-[#FAFBF7] text-[#536159]">
                  {dense ? <LayoutGrid size={16} /> : <ListFilter size={16} />}
                </button>
              </div>
            </div>

            {selected.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-[#BFD8CA] bg-[#E8F2EC] px-3 py-2.5 text-sm text-[#315D49]">
                <span className="lcb-mono mr-1 text-[11px]">{selected.length.toString().padStart(2, "0")} selected</span>
                <button onClick={() => sendAction("Marked selected leads as contacted")} className="rounded-md bg-[#CFE4D8] px-2.5 py-1 font-medium">Mark contacted</button>
                <button onClick={() => sendAction("Assignment panel opened")} className="rounded-md px-2.5 py-1 font-medium hover:bg-[#DCECE2]">Assign</button>
                <button onClick={() => setSelected([])} className="ml-auto p-1"><X size={15} /></button>
              </div>
            )}

            <div className={`grid gap-3 ${dense ? "md:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-3"}`}>
              {visibleLeads.map((lead, index) => {
                const badge = statusStyles[lead.status];
                return (
                  <article key={lead.id} className="lcb-card lcb-reveal rounded-xl border border-[#D9DED5] bg-[#FCFDF9] p-4 shadow-[0_2px_0_rgba(35,48,43,.03)]" style={{ animationDelay: `${index * 45}ms` }}>
                    <div className="mb-4 flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <button onClick={() => toggleLead(lead.id)} aria-label={`Select ${lead.name}`} className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-[#B8C3B9] bg-[#FCFDF9]">
                          {selected.includes(lead.id) && <Check size={12} strokeWidth={3} color="#2A7452" />}
                        </button>
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold text-[#35483D]" style={{ background: lead.tone }}>{lead.initials}</div>
                        <div className="min-w-0">
                          <h2 className="truncate text-[15px] font-semibold tracking-[-.015em] text-[#26342D]">{lead.name}</h2>
                          <p className="mt-0.5 text-xs text-[#778279]">{lead.source}</p>
                        </div>
                      </div>
                      <button onClick={() => sendAction(`Options for ${lead.name}`)} className="rounded-md p-1 text-[#778279] hover:bg-[#EFF1EB]"><Ellipsis size={19} /></button>
                    </div>
                    <div className="mb-4 flex items-center justify-between">
                      <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold" style={{ background: badge.bg, color: badge.color }}>
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: badge.dot }} /> {lead.status}
                      </span>
                      <span className="lcb-mono text-[10px] text-[#869087]">{lead.time}</span>
                    </div>
                    {lead.note && <p className="mb-3 rounded-lg border-l-2 border-[#E68A4E] bg-[#FFF8F0] px-2.5 py-2 text-xs leading-5 text-[#6E5B4C]">{lead.note}</p>}
                    <div className="space-y-2.5 border-t border-[#E4E8E1] pt-3 text-xs text-[#647067]">
                      <p className="flex gap-2"><Phone size={14} className="shrink-0 text-[#859188]" />{lead.phone}</p>
                      <p className="flex min-w-0 gap-2"><Mail size={14} className="shrink-0 text-[#859188]" /><span className="truncate">{lead.email}</span></p>
                      <p className="flex min-w-0 gap-2"><MapPin size={14} className="mt-0.5 shrink-0 text-[#859188]" /><span className="truncate">{lead.address}</span></p>
                    </div>
                    <div className="mt-4 flex items-center justify-between gap-2">
                      {lead.task ? <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-[#597066]"><Clock3 size={13} className="shrink-0 text-[#D06E37]" /><span className="truncate">{lead.task}</span></span> : <span />}
                      <button onClick={() => sendAction(`Opened ${lead.name}`)} className="flex shrink-0 items-center gap-1 text-xs font-semibold text-[#34674F]">Open <ChevronDown size={13} className="-rotate-90" /></button>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>

          <aside className="lcb-reveal order-first rounded-xl border border-[#D9DED5] bg-[#E9EEE6] p-4 lg:order-none" style={{ animationDelay: "120ms" }}>
            <div className="mb-5 flex items-center justify-between">
              <div>
                <p className="lcb-mono text-[10px] uppercase tracking-[.13em] text-[#738077]">Today’s focus</p>
                <h2 className="lcb-fraunces mt-1 text-xl tracking-[-.03em] text-[#284137]">The call list</h2>
              </div>
              <button onClick={() => sendAction("Focus settings opened")} className="rounded-md p-1 text-[#68756C]"><Filter size={16} /></button>
            </div>
            <div className="mb-4 rounded-lg bg-[#FCFDF9] p-3">
              <p className="lcb-mono text-[10px] uppercase tracking-[.13em] text-[#7E8B81]">Response window</p>
              <p className="mt-1 text-2xl font-semibold tracking-[-.04em] text-[#274337]">18 min</p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#E0E6DD]"><div className="h-full w-[71%] rounded-full bg-[#E27635]" /></div>
              <p className="mt-2 text-[11px] text-[#66736B]">7 of 10 new leads reached in under 30 min</p>
            </div>
            <div className="space-y-2">
              {[
                ["09:30", "Maya Hart", "Call", "#E27635"],
                ["11:15", "Nolan Reyes", "Email", "#5477B8"],
                ["13:00", "Priya Shah", "Visit", "#4E9B78"],
              ].map(([time, name, type, color]) => (
                <button key={name} onClick={() => sendAction(`${type} task opened for ${name}`)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-[#F3F6F0]">
                  <span className="lcb-mono text-[10px] text-[#718075]">{time}</span>
                  <span className="h-2 w-2 rounded-full" style={{ background: color }} />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-[#415048]">{name}</span>
                  <span className="text-[10px] text-[#77847B]">{type}</span>
                </button>
              ))}
            </div>
            <button onClick={() => sendAction("Calendar opened")} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-[#CBD6CA] bg-transparent py-2 text-xs font-semibold text-[#506158]"><CalendarDays size={14} /> View calendar</button>
          </aside>
        </section>
      </div>

      {showNew && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-[#20332B]/25 p-4">
          <div className="w-full max-w-md rounded-2xl border border-[#D6DCD1] bg-[#FCFDF9] p-5 shadow-2xl">
            <div className="mb-5 flex items-start justify-between">
              <div><p className="lcb-mono text-[10px] uppercase tracking-[.14em] text-[#7B867D]">New record</p><h2 className="lcb-fraunces text-2xl text-[#263B32]">Add a lead</h2></div>
              <button onClick={() => setShowNew(false)} className="rounded-md p-1 text-[#6B786E]"><X size={18} /></button>
            </div>
            <div className="space-y-3">
              <input className="w-full rounded-lg border border-[#D7DDD4] bg-[#F9FAF6] px-3 py-2.5 text-sm outline-none" placeholder="Full name" />
              <input className="w-full rounded-lg border border-[#D7DDD4] bg-[#F9FAF6] px-3 py-2.5 text-sm outline-none" placeholder="Phone or email" />
              <button onClick={() => { setShowNew(false); sendAction("Lead saved to your inbox"); }} className="w-full rounded-lg bg-[#E57735] py-2.5 text-sm font-semibold text-[#FFFCF5]">Save lead</button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="fixed bottom-5 left-1/2 z-30 -translate-x-1/2 rounded-full bg-[#253D35] px-4 py-2 text-sm font-medium text-[#F7F8F2] shadow-lg">{toast}</div>}
    </main>
  );
}