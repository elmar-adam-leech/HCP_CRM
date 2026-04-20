import { Link } from "wouter";
import { FileText, Users, Wrench, Mail, BarChart3, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

const features = [
  {
    icon: Users,
    title: "Lead Management",
    description: "Capture, track, and convert leads from multiple sources including Gmail, Facebook, and web forms.",
  },
  {
    icon: FileText,
    title: "Estimates & Jobs",
    description: "Create professional estimates, convert them to jobs, and track progress from start to finish.",
  },
  {
    icon: Mail,
    title: "Gmail Integration",
    description: "Sync your Gmail inbox to automatically create leads from inbound emails and send replies directly from the CRM.",
  },
  {
    icon: Zap,
    title: "Workflow Automation",
    description: "Automate follow-ups, lead assignments, and notifications so nothing falls through the cracks.",
  },
  {
    icon: BarChart3,
    title: "Reports & Analytics",
    description: "Track revenue, conversion rates, and team performance with built-in reporting dashboards.",
  },
  {
    icon: Wrench,
    title: "HouseCall Pro Sync",
    description: "Two-way sync with HouseCall Pro keeps your customer, estimate, and job data always up to date.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Header */}
      <header className="border-b">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <img src="/hcp-crm-logo.png" alt="HCP CRM" className="h-8 w-8 object-contain" />
            <span className="text-xl font-bold tracking-tight">HCP CRM</span>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="flex-1 flex items-center justify-center px-6 py-20 text-center">
        <div className="max-w-2xl">
          <h1 className="text-4xl font-bold tracking-tight mb-4 sm:text-5xl">
            The CRM built for Housecall Pro
          </h1>
          <p className="text-lg text-muted-foreground mb-8">
            Bring together your leads, estimates, jobs, and communications
            in one place — with direct integrations for Gmail, Housecall Pro, Dialpad,
            and Facebook.
          </p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <Button size="lg" asChild>
              <Link href="/signup">Get Started</Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href="/login">Sign In</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t py-16 px-6">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-2xl font-semibold text-center mb-10">
            Everything your team needs to close more jobs
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((f) => (
              <div key={f.title} className="p-5 rounded-md border bg-card">
                <f.icon className="h-5 w-5 text-primary mb-3" />
                <h3 className="font-semibold mb-1">{f.title}</h3>
                <p className="text-sm text-muted-foreground">{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-6 px-6">
        <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <img src="/hcp-crm-logo.png" alt="HCP CRM" className="h-4 w-4 object-contain" />
            <span>&copy; {new Date().getFullYear()} HCP CRM. All rights reserved.</span>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/privacy" className="text-muted-foreground hover:text-foreground hover:underline">
              Privacy Policy
            </Link>
            <Link href="/terms" className="text-muted-foreground hover:text-foreground hover:underline">
              Terms of Service
            </Link>
            <Link href="/licenses" className="text-muted-foreground hover:text-foreground hover:underline">
              Open Source Licenses
            </Link>
            <Link href="/login" className="text-muted-foreground hover:text-foreground hover:underline">
              Sign In
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
