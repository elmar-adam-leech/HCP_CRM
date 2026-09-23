import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronDown,
  CircleDot,
  Clock3,
  Mail,
  MapPin,
  MessageSquare,
  MoreHorizontal,
  Phone,
  Plus,
  Search,
  Send,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";

type Lead = {
  id: number;
  name: string;
  initials: string;
  source: string;
  created: string;
  priority: "Hot" | "Warm" | "Standard";
  intent: string;
  phone: string;
  email: string;
  address: string;
  note: string;
};

const leadQueue: Lead[] = [
  { id: 1, name: "Maya Hart", initials: "MH", source: "Facebook lead ad", created: "8m", priority: "Hot", intent: "Ductless install", phone: "(415) 555-0184", email: "maya.hart@email.com", address: "1143 Valencia St, San Francisco", note: "Looking for a same-week estimate. Condo board approval is already in place." },
  { id: 2, name: "Theo Bennett", initials: "TB", source: "Google Local", created: "19m", priority: "Hot", intent: "No-cool repair", phone: "(415) 555-0165", email: "theo.bennett@email.com", address: "88 Townsend St, San Francisco", note: "AC stopped overnight. Available after 3 PM today." },
  { id: 3, name: "Nolan Reyes", initials: "NR", source: "Website request", created: "42m", priority: "Warm", intent: "Maintenance plan", phone: "(415) 555-0127", email: "nolan.reyes@email.com", address: "2380 18th St, San Francisco", note: "Asked for annual plan options for a two-unit building." },
  { id: 4, name: "Priya Shah", initials: "PS", source: "Referral", created: "1h", priority: "Warm", intent: "Heat pump consult", phone: "(415) 555-0192", email: "priya.shah@email.com", address: "701 Corbett Ave, San Francisco", note: "Referred by Elise Morgan. Prefers a Thursday walkthrough." },
  { id: 5, name: "Celia Ward", initials: "CW", source: "Facebook lead ad", created: "2h", priority: "Standard", intent: "Filter service", phone: "(415) 555-0143", email: "celia.ward@email.com", address: "460 Noe St, San Francisco", note: "Interested in a recurring service visit." },
];

const tones = ["#F0D8C5", "#D6E5DC", "#D9D9F0", "#E9DEB9", "#D4E5E9"];

export function LeadTriageStation() {
  const [activeLane, setActiveLane] = useState("Now");
  const [selectedId, setSelectedId] = useState(1);
  const [search, setSearch] = useState("");
  const [completed, setCompleted] = useState<number[]>([]);
  const [toast, setToast] = useState("");
  const [showNew, setShowNew] = useState(false);
  const selected = leadQueue.find((lead) => lead.id === selectedId) ?? leadQueue[0];
  const visible = useMemo(
    () => leadQueue.filter((lead) => `${lead.name} ${lead.intent} ${lead.source}`.toLowerCase().includes(search.toLowerCase())),
    [search],
  );
  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2100);
  };

  return (
    <main className="min-h-[100dvh] bg-[#F1EFE8] p-3 text-[#26302D] sm:p-5" style={{ fontFamily: '"Outfit", "Trebuchet MS", sans-serif' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&family=Outfit:wght@400;500;600;700&display=swap');
        .lts-serif { font-family: "Instrument Serif", Georgia, serif; }
        .lts-mono { font-family: "DM Mono", monospace; }
        .lts-item { transition: background 170ms ease, transform 170ms ease; }
        .lts-item:hover { transform: translateX(2px); }
        .lts-in { animation: lts-in .48s both; }
        @keyframes lts-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      <div className="mx-auto min-h-[calc(100dvh-24px)] max-w-[1500px] overflow-hidden rounded-[24px] border border-[#D4D1C6] bg-[#FAF9F4] shadow-[0_20px_70px_rgba(52,57,48,.13)] sm:min-h-[calc(100dvh-40px)]">
        <header className="flex flex-col gap-4 border-b border-[#DEDCD2] px-5 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-7">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[#E86F41] text-[#FFF9F1]"><Sparkles size={19} /></div>
            <div>
              <p className="lts-mono text-[10px] uppercase tracking-[.15em] text-[#8B8A82]">Fieldbook / intake desk</p>
              <h1 className="lts-serif -mt-1 text-[31px] leading-none tracking-[-.04em]">Lead triage</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => notify("Coverage settings opened")} className="hidden rounded-lg px-3 py-2 text-sm font-medium text-[#6B7069] hover:bg-[#F0EFE8] sm:block">Today: East Bay team <ChevronDown className="ml-1 inline" size={14} /></button>
            <button onClick={() => setShowNew(true)} className="flex items-center gap-2 rounded-lg bg-[#29483D] px-3.5 py-2.5 text-sm font-semibold text-[#FFFDF7]"><Plus size={16} /> New lead</button>
          </div>
        </header>

        <div className="grid lg:grid-cols-[252px_minmax(330px,1fr)_minmax(330px,1.05fr)]">
          <aside className="border-b border-[#DEDCD2] bg-[#F5F3EC] p-4 lg:min-h-[670px] lg:border-b-0 lg:border-r">
            <p className="lts-mono mb-3 text-[10px] uppercase tracking-[.14em] text-[#908F86]">Work queues</p>
            <nav className="flex gap-1 overflow-auto lg:block lg:space-y-1">
              {[["Now", "04"], ["Next up", "08"], ["Waiting", "11"], ["All leads", "24"]].map(([label, count]) => (
                <button key={label} onClick={() => setActiveLane(label)} className={`flex shrink-0 items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium lg:w-full ${activeLane === label ? "bg-[#29483D] text-[#FFFDF7]" : "text-[#5E655F] hover:bg-[#EAE9E1]"}`}>
                  {label}<span className={`lts-mono text-[10px] ${activeLane === label ? "text-[#DFE7DE]" : "text-[#9A9B91]"}`}>{count}</span>
                </button>
              ))}
            </nav>
            <div className="mt-7 hidden border-t border-[#DEDCD2] pt-5 lg:block">
              <p className="lts-mono text-[10px] uppercase tracking-[.14em] text-[#908F86]">Live pulse</p>
              <div className="mt-3 rounded-xl bg-[#ECE9DE] p-3">
                <div className="flex items-end justify-between"><span className="text-sm font-medium">Response pace</span><span className="lts-serif text-3xl text-[#315D4C]">12m</span></div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#D4D8CD]"><div className="h-full w-[78%] rounded-full bg-[#DF7445]" /></div>
                <p className="mt-2 text-xs leading-4 text-[#72766F]">Ahead of your 20 min target today.</p>
              </div>
            </div>
          </aside>

          <section className="border-b border-[#DEDCD2] p-4 lg:border-b-0 lg:border-r lg:p-5">
            <div className="mb-4 flex items-end justify-between">
              <div><p className="lts-mono text-[10px] uppercase tracking-[.14em] text-[#8B8A82]">{activeLane} / 04 records</p><h2 className="lts-serif mt-0.5 text-[27px] leading-none">Make the next move.</h2></div>
              <button onClick={() => notify("Queue filters opened")} className="rounded-lg border border-[#DAD8CE] p-2 text-[#69726B]"><CircleDot size={17} /></button>
            </div>
            <label className="mb-3 flex items-center gap-2 rounded-lg border border-[#DDDAD0] bg-[#FFFDF8] px-3 py-2.5 text-[#8C9088]">
              <Search size={16}/><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a lead" className="min-w-0 flex-1 bg-transparent text-sm text-[#303A35] outline-none placeholder:text-[#A3A49C]" />
            </label>
            <div className="space-y-2">
              {visible.map((lead, index) => {
                const done = completed.includes(lead.id);
                return <button key={lead.id} onClick={() => setSelectedId(lead.id)} className={`lts-item lts-in w-full rounded-xl border p-3 text-left ${selected.id === lead.id ? "border-[#799B89] bg-[#EEF4ED] shadow-[0_3px_0_#D7E3D5]" : "border-[#E3E1D8] bg-[#FFFDF8] hover:border-[#C9D1C7]"}`} style={{ animationDelay: `${index * 45}ms` }}>
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold text-[#39443D]" style={{ background: tones[index] }}>{lead.initials}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between gap-2"><p className={`text-sm font-semibold ${done ? "text-[#88928A] line-through" : ""}`}>{lead.name}</p><span className="lts-mono text-[10px] text-[#90948C]">{lead.created}</span></div>
                      <p className="mt-0.5 text-xs text-[#727970]">{lead.intent} <span className="text-[#B0B1A9]">/</span> {lead.source}</p>
                      <div className="mt-2 flex items-center justify-between"><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${lead.priority === "Hot" ? "bg-[#FBE4D6] text-[#A64D26]" : lead.priority === "Warm" ? "bg-[#F4ECCB] text-[#846A1C]" : "bg-[#E8ECE5] text-[#667367]"}`}>{lead.priority}</span>{done && <Check size={14} className="text-[#478165]" />}</div>
                    </div>
                  </div>
                </button>;
              })}
            </div>
          </section>

          <section className="bg-[#FFFEFA] p-5 lg:p-7">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3"><div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#F0D8C5] text-sm font-bold text-[#4A5149]">{selected.initials}</div><div><h2 className="lts-serif text-[29px] leading-none">{selected.name}</h2><p className="mt-1 text-xs text-[#73786F]">{selected.source} · {selected.created} ago</p></div></div>
              <button onClick={() => notify("More actions available")} className="rounded-lg p-2 text-[#6E756E] hover:bg-[#F0EFE9]"><MoreHorizontal size={19}/></button>
            </div>
            <div className="mt-6 rounded-xl border border-[#E6D7C9] bg-[#FFF7F1] p-4">
              <p className="lts-mono text-[10px] uppercase tracking-[.14em] text-[#A27056]">Recommended first move</p>
              <p className="mt-1 text-lg font-semibold tracking-[-.02em] text-[#543C30]">Call within 12 minutes</p>
              <p className="mt-1 text-sm leading-5 text-[#786051]">Highest intent in the queue. Their preferred window ends at 10:30 AM.</p>
              <div className="mt-3 flex gap-2"><button onClick={() => notify(`Calling ${selected.name}`)} className="flex items-center gap-2 rounded-lg bg-[#D96739] px-3 py-2 text-sm font-semibold text-[#FFF9F3]"><Phone size={15}/> Start call</button><button onClick={() => notify("Message composer opened")} className="rounded-lg border border-[#E3BDA9] px-3 py-2 text-sm font-semibold text-[#A34D2C]"><MessageSquare size={15}/></button></div>
            </div>
            <div className="mt-6">
              <p className="lts-mono mb-2 text-[10px] uppercase tracking-[.14em] text-[#91938A]">Lead context</p>
              <p className="rounded-lg border-l-2 border-[#E07A4B] bg-[#F8F6F0] px-3 py-3 text-sm leading-5 text-[#565E57]">{selected.note}</p>
            </div>
            <div className="mt-5 space-y-3 border-t border-[#E8E6DE] pt-5 text-sm text-[#5F685F]">
              <a href={`tel:${selected.phone}`} className="flex items-center gap-3 hover:text-[#29483D]"><Phone size={16} className="text-[#D67145]"/>{selected.phone}<ArrowUpRight className="ml-auto" size={14}/></a>
              <a href={`mailto:${selected.email}`} className="flex items-center gap-3 hover:text-[#29483D]"><Mail size={16} className="text-[#D67145]"/>{selected.email}<ArrowUpRight className="ml-auto" size={14}/></a>
              <button onClick={() => notify("Map opened")} className="flex w-full items-center gap-3 text-left hover:text-[#29483D]"><MapPin size={16} className="text-[#D67145]"/>{selected.address}<ArrowUpRight className="ml-auto" size={14}/></button>
            </div>
            <div className="mt-6 flex gap-2">
              <button onClick={() => setCompleted((current) => current.includes(selected.id) ? current.filter((id) => id !== selected.id) : [...current, selected.id])} className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-[#C9D9CC] bg-[#EEF5EE] px-3 py-2.5 text-sm font-semibold text-[#35624D]"><Check size={16}/>{completed.includes(selected.id) ? "Reopen" : "Mark handled"}</button>
              <button onClick={() => notify("Scheduling opened")} className="rounded-lg border border-[#DDDAD0] px-3 text-[#59655D]"><CalendarDays size={17}/></button>
              <button onClick={() => notify("Assigned to Lina Ortiz")} className="rounded-lg border border-[#DDDAD0] px-3 text-[#59655D]"><UserRound size={17}/></button>
            </div>
          </section>
        </div>
      </div>
      {showNew && <div className="fixed inset-0 z-20 flex items-center justify-center bg-[#22332B]/30 p-4"><div className="w-full max-w-sm rounded-2xl bg-[#FFFDF8] p-5 shadow-2xl"><div className="flex justify-between"><div><p className="lts-mono text-[10px] uppercase tracking-[.15em] text-[#8B8A82]">Intake</p><h2 className="lts-serif text-3xl">New lead</h2></div><button onClick={() => setShowNew(false)}><X size={18}/></button></div><input placeholder="Name" className="mt-5 w-full rounded-lg border border-[#DDDAD0] bg-[#FAF9F4] px-3 py-2.5 text-sm outline-none"/><input placeholder="Phone or email" className="mt-2 w-full rounded-lg border border-[#DDDAD0] bg-[#FAF9F4] px-3 py-2.5 text-sm outline-none"/><button onClick={() => { setShowNew(false); notify("Lead added to triage"); }} className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-[#29483D] py-2.5 text-sm font-semibold text-white"><Send size={15}/> Add to queue</button></div></div>}
      {toast && <div className="fixed bottom-5 left-1/2 z-30 -translate-x-1/2 rounded-full bg-[#29483D] px-4 py-2 text-sm font-medium text-[#FFFDF7] shadow-lg">{toast}</div>}
    </main>
  );
}