import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronRight,
  CircleAlert,
  Clock,
  Inbox,
  MapPin,
  MessageCircle,
  Phone,
  Search,
  Sparkles,
  X,
} from "lucide-react";

type Lead = {
  id: number;
  name: string;
  initials: string;
  tone: string;
  source: string;
  message: string;
  arrived: string;
  location: string;
  value: string;
  urgency: "Respond now" | "Today" | "Nurture";
  detail: string;
};

const leads: Lead[] = [
  { id: 1, name: "Mara Whitcomb", initials: "MW", tone: "#ebc6aa", source: "Facebook lead ad", message: "Looking to redo our backyard before the kids are home for summer. Can someone visit this week?", arrived: "12 min ago", location: "Windsor Park", value: "$8.4k", urgency: "Respond now", detail: "Phone + address verified" },
  { id: 2, name: "David N. Chen", initials: "DC", tone: "#b9d6c0", source: "Website inquiry", message: "Need an estimate for a small deck repair. Prefer an afternoon appointment.", arrived: "38 min ago", location: "East Austin", value: "$3.2k", urgency: "Respond now", detail: "Phone verified" },
  { id: 3, name: "Elena Moreno", initials: "EM", tone: "#c6caeb", source: "Google Local Services", message: "A neighbor recommended you. What does a typical project timeline look like?", arrived: "Yesterday", location: "Zilker", value: "$6.1k", urgency: "Today", detail: "Last touch: none" },
  { id: 4, name: "Jordan & Co.", initials: "JC", tone: "#e6cfb0", source: "Referral", message: "We’re comparing bids for a storefront exterior refresh.", arrived: "Yesterday", location: "East 11th", value: "$12.7k", urgency: "Today", detail: "Referred by R. Singh" },
  { id: 5, name: "The Alder House", initials: "AH", tone: "#c8dbd0", source: "Website inquiry", message: "Interested in a complete front garden redesign later this season.", arrived: "Jun 18", location: "Clarksville", value: "$19.5k", urgency: "Nurture", detail: "Timeline: August" },
];

const tabs = ["All inbox", "Respond now", "Today", "Nurture"] as const;

export default function LeadRefinementTriage() {
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("All inbox");
  const [selectedId, setSelectedId] = useState(1);
  const [query, setQuery] = useState("");
  const [completed, setCompleted] = useState<number[]>([]);
  const [toast, setToast] = useState("");

  const visible = useMemo(() => leads.filter((lead) => {
    const matchTab = activeTab === "All inbox" || lead.urgency === activeTab;
    const matchSearch = `${lead.name} ${lead.source} ${lead.location}`.toLowerCase().includes(query.toLowerCase());
    return matchTab && matchSearch && !completed.includes(lead.id);
  }), [activeTab, completed, query]);

  const active = leads.find((lead) => lead.id === selectedId) ?? visible[0] ?? leads[0];
  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  };
  const complete = (id: number) => {
    setCompleted((items) => [...items, id]);
    const next = leads.find((lead) => lead.id !== id && !completed.includes(lead.id));
    if (next) setSelectedId(next.id);
    notify("Lead moved to follow-up");
  };

  return (
    <main className="triage-shell min-h-screen overflow-hidden bg-[#f1eee7] text-[#283636]">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700&family=Fraunces:opsz,wght@9..144,600;9..144,700&display=swap');
        .triage-shell * { box-sizing:border-box; }
        .triage-shell button, .triage-shell input { font:inherit; }
        .triage-shell { font-family:'DM Sans',sans-serif; }
        .triage-serif { font-family:'Fraunces',Georgia,serif; }
        .triage-mono { font-family:'DM Mono',monospace; }
        .triage-paper { background-image:linear-gradient(90deg,rgba(255,255,255,.34),rgba(255,255,255,.12)); }
        @keyframes triage-in { from { opacity:0; transform:translateY(12px) } to { opacity:1; transform:translateY(0) } }
        .triage-in { animation:triage-in .5s cubic-bezier(.2,.75,.2,1) both; }
      `}</style>
      <div className="mx-auto flex min-h-[100dvh] max-w-[1536px] flex-col border-x border-[#d8d4c9] bg-[#f8f6f0] lg:flex-row">
        <aside className="flex shrink-0 flex-row justify-between border-b border-[#d8d4c9] bg-[#e6e4da] p-4 lg:w-[82px] lg:flex-col lg:border-b-0 lg:border-r lg:py-6">
          <div className="flex gap-3 lg:flex-col">
            <div className="grid h-11 w-11 place-items-center rounded-[15px] bg-[#24544d] text-lg font-bold text-[#f7f4eb]">H</div>
            <button onClick={() => notify("Inbox selected")} className="grid h-11 w-11 place-items-center rounded-[15px] bg-[#f7f5ef] text-[#24544d] shadow-[0_2px_0_rgba(30,59,53,.15)]"><Inbox size={20} /></button>
            <button onClick={() => notify("Calendar opened")} className="grid h-11 w-11 place-items-center rounded-[15px] text-[#6f7770] hover:bg-[#efede6]"><CalendarClock size={20} /></button>
          </div>
          <button onClick={() => notify("Avery's account opened")} className="grid h-10 w-10 place-items-center rounded-full border border-[#c6c9bc] bg-[#d8c4cf] text-[11px] font-bold text-[#614958]">AN</button>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#d8d4c9] px-5 py-4 md:px-8">
            <div><p className="triage-mono text-[10px] uppercase tracking-[.14em] text-[#708078]">Hearthline / Austin operations</p><h1 className="triage-serif mt-1 text-[25px] tracking-[-.045em] text-[#28433e]">The response desk</h1></div>
            <div className="flex items-center gap-2"><span className="hidden rounded-full bg-[#f3dbcc] px-3 py-1.5 text-[11px] font-bold text-[#9d5535] sm:block">2 need a reply</span><button onClick={() => notify("New lead capture opened")} className="rounded-lg bg-[#24544d] px-4 py-2.5 text-[12px] font-bold text-[#f7f4ed] shadow-[0_3px_0_#173d37] active:translate-y-px">Capture lead</button></div>
          </header>

          <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(315px,.92fr)_minmax(410px,1.35fr)]">
            <section className="border-b border-[#d8d4c9] lg:border-b-0 lg:border-r">
              <div className="border-b border-[#dedbd1] px-5 pb-4 pt-5 md:px-7">
                <div className="flex items-end justify-between"><div><p className="triage-mono text-[10px] uppercase tracking-[.14em] text-[#7d887e]">Live intake</p><h2 className="triage-serif mt-1 text-[23px] tracking-[-.04em]">Choose the next conversation.</h2></div><span className="triage-mono text-[11px] text-[#57726a]">{visible.length} open</span></div>
                <div className="mt-5 flex gap-1 overflow-x-auto pb-1">
                  {tabs.map((tab) => <button key={tab} onClick={() => setActiveTab(tab)} className={`whitespace-nowrap rounded-full px-3 py-1.5 text-[11px] font-bold transition ${activeTab === tab ? "bg-[#284b45] text-[#f8f5ed]" : "text-[#68736b] hover:bg-[#eae8e0]"}`}>{tab}</button>)}
                </div>
                <label className="mt-4 flex h-10 items-center gap-2 rounded-lg border border-[#dedbd1] bg-[#fbfaf5] px-3 text-[#859087] focus-within:border-[#78988c]"><Search size={16}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a person or source" className="w-full bg-transparent text-[12px] text-[#33443e] outline-none placeholder:text-[#9da59e]" /></label>
              </div>
              <div className="max-h-[520px] overflow-y-auto">
                {visible.map((lead, index) => <button key={lead.id} onClick={() => setSelectedId(lead.id)} className={`group w-full border-b border-[#e4e1d8] px-5 py-4 text-left transition md:px-7 ${active.id === lead.id ? "bg-[#e4eee8]" : "hover:bg-[#f1f0ea]"}`}>
                  <div className="flex gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-[11px] font-bold text-[#3b4d48]" style={{ backgroundColor: lead.tone }}>{lead.initials}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-2"><p className="truncate text-[13px] font-bold">{lead.name}</p><span className={`shrink-0 rounded-full px-2 py-1 text-[9px] font-bold ${lead.urgency === "Respond now" ? "bg-[#f6d8c9] text-[#a04f31]" : lead.urgency === "Today" ? "bg-[#f0e7bd] text-[#80621a]" : "bg-[#dde6df] text-[#47705c]"}`}>{lead.urgency}</span></div><p className="mt-1 truncate text-[11px] leading-relaxed text-[#66746d]">{lead.message}</p><div className="mt-2 flex items-center gap-2 text-[10px] text-[#89928a]"><span>{lead.source}</span><span>•</span><span>{lead.arrived}</span>{index === 0 && <i className="ml-auto h-2 w-2 rounded-full bg-[#d46b47]" />}</div></div></div>
                </button>)}
                {!visible.length && <div className="px-8 py-16 text-center"><Check className="mx-auto mb-3 text-[#719686]" size={25}/><p className="triage-serif text-xl">A clear desk.</p><button onClick={() => { setQuery(""); setActiveTab("All inbox"); }} className="mt-2 text-[11px] font-bold text-[#2c685d]">Show all leads</button></div>}
              </div>
            </section>

            <article className="triage-paper triage-in relative flex min-h-[520px] flex-col bg-[#fbfaf5] px-5 py-6 md:px-9 md:py-8">
              <div className="flex items-start justify-between gap-4"><div className="flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-full text-[12px] font-bold text-[#3b4d48]" style={{ backgroundColor: active.tone }}>{active.initials}</div><div><p className="triage-mono text-[10px] uppercase tracking-[.12em] text-[#718078]">{active.source}</p><h2 className="triage-serif text-[28px] tracking-[-.05em]">{active.name}</h2></div></div><button onClick={() => notify("Lead card closed")} className="grid h-9 w-9 place-items-center rounded-full text-[#778078] hover:bg-[#eeeae1]"><X size={18}/></button></div>
              <div className="mt-7 rounded-[18px] border border-[#dedbd1] bg-[#f6f2e9] p-5"><div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.12em] text-[#a05b3d]"><CircleAlert size={14}/> Their note</div><p className="triage-serif mt-3 text-[20px] leading-[1.35] tracking-[-.025em] text-[#31423d]">“{active.message}”</p><p className="mt-4 triage-mono text-[10px] text-[#889188]">Received {active.arrived} · form completion</p></div>
              <div className="mt-6 grid gap-3 sm:grid-cols-3"><div><p className="triage-mono text-[9px] uppercase tracking-[.11em] text-[#8a948b]">Potential</p><p className="mt-1 text-[15px] font-bold text-[#24544d]">{active.value}</p></div><div><p className="triage-mono text-[9px] uppercase tracking-[.11em] text-[#8a948b]">Area</p><p className="mt-1 flex items-center gap-1 text-[12px] font-bold"><MapPin size={13} className="text-[#a36547]"/>{active.location}</p></div><div><p className="triage-mono text-[9px] uppercase tracking-[.11em] text-[#8a948b]">Signal</p><p className="mt-1 text-[12px] font-bold">{active.detail}</p></div></div>
              <div className="mt-auto border-t border-[#ddd9cf] pt-6"><p className="triage-mono mb-3 text-[10px] uppercase tracking-[.13em] text-[#758178]">Choose a first move</p><div className="grid gap-2 sm:grid-cols-2"><button onClick={() => notify(`Calling ${active.name}`)} className="flex items-center justify-between rounded-xl bg-[#24544d] px-4 py-3.5 text-left text-[12px] font-bold text-[#f9f6ee] shadow-[0_3px_0_#173d37]"><span className="flex items-center gap-2"><Phone size={15}/> Call now</span><ArrowUpRight size={15}/></button><button onClick={() => notify(`Reply composer opened for ${active.name}`)} className="flex items-center justify-between rounded-xl border border-[#cfd4cb] bg-[#fdfbf6] px-4 py-3.5 text-left text-[12px] font-bold text-[#344943] hover:bg-[#f0eee7]"><span className="flex items-center gap-2"><MessageCircle size={15}/> Send reply</span><ChevronRight size={15}/></button><button onClick={() => notify("Scheduling panel opened")} className="flex items-center gap-2 rounded-xl px-3 py-2 text-[11px] font-bold text-[#577067] hover:bg-[#eeece5]"><Clock size={14}/> Offer a visit time</button><button onClick={() => complete(active.id)} className="flex items-center gap-2 rounded-xl px-3 py-2 text-[11px] font-bold text-[#577067] hover:bg-[#eeece5]"><Check size={14}/> Mark as handled</button></div></div>
            </article>
          </div>
        </section>
      </div>
      {toast && <div className="fixed bottom-5 right-5 rounded-xl bg-[#203e39] px-4 py-3 text-[12px] font-bold text-[#f8f5ec] shadow-xl">{toast}</div>}
    </main>
  );
}