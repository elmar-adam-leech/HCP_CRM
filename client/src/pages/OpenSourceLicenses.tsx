import { Link } from "wouter";
import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Search, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

type Package = {
  name: string;
  version: string;
  repository: string;
  publisher: string;
};

type LicenseGroup = {
  license: string;
  licenseText: string;
  packages: Package[];
};

function matchesGroup(group: LicenseGroup, q: string): boolean {
  return (
    group.license.toLowerCase().includes(q) ||
    group.packages.some(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.publisher.toLowerCase().includes(q)
    )
  );
}

function LicenseSection({ group, search }: { group: LicenseGroup; search: string }) {
  const [showText, setShowText] = useState(false);

  const licenseMatches = search && group.license.toLowerCase().includes(search);
  const filtered = !search
    ? group.packages
    : licenseMatches
      ? group.packages
      : group.packages.filter(
          (p) =>
            p.name.toLowerCase().includes(search) ||
            p.publisher.toLowerCase().includes(search)
        );

  if (filtered.length === 0) return null;

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">{group.license}</h2>
          <Badge variant="secondary" className="text-xs">
            {filtered.length} {filtered.length === 1 ? "package" : "packages"}
          </Badge>
        </div>
        {group.licenseText && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowText(!showText)}
          >
            {showText ? (
              <>
                <ChevronUp className="h-4 w-4 mr-1" /> Hide license text
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4 mr-1" /> Show license text
              </>
            )}
          </Button>
        )}
      </div>

      {showText && group.licenseText && (
        <pre className="mb-4 p-3 bg-muted rounded-md text-xs whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto">
          {group.licenseText}
        </pre>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {filtered.map((pkg) => (
          <div
            key={`${pkg.name}@${pkg.version}`}
            className="flex items-center gap-1 py-1 text-sm min-w-0"
          >
            <span className="truncate font-medium">{pkg.name}</span>
            <span className="text-muted-foreground text-xs shrink-0">
              {pkg.version}
            </span>
            {pkg.repository && (
              <a
                href={pkg.repository}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground shrink-0"
                aria-label={`Repository for ${pkg.name}`}
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function OpenSourceLicenses() {
  const [search, setSearch] = useState("");
  const [groups, setGroups] = useState<LicenseGroup[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);

  useEffect(() => {
    fetch("/third-party-licenses.json")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load");
        return res.json();
      })
      .then((data) => {
        setGroups(data);
        setIsLoading(false);
      })
      .catch(() => {
        setIsError(true);
        setIsLoading(false);
      });
  }, []);

  const q = search.toLowerCase().trim();
  const totalPackages = groups?.reduce((s, g) => s + g.packages.length, 0) ?? 0;

  const hasResults = !q || groups?.some((g) => matchesGroup(g, q));

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold mb-2">Open Source Licenses</h1>
        <p className="text-sm text-muted-foreground mb-6">
          This application uses {totalPackages} open source packages across{" "}
          {groups?.length ?? 0} license types. Expand any section to view the
          full license text.
        </p>

        {isLoading && (
          <div className="space-y-3 animate-pulse">
            <div className="h-4 bg-muted rounded w-3/4" />
            <div className="h-4 bg-muted rounded w-full" />
            <div className="h-4 bg-muted rounded w-5/6" />
          </div>
        )}

        {isError && (
          <p className="text-center text-muted-foreground py-8">
            Failed to load license information. Please try again later.
          </p>
        )}

        {!isLoading && !isError && groups && (
          <>
            <div className="relative mb-6">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search packages or publishers..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>

            <div className="space-y-4">
              {groups.map((group) => (
                <LicenseSection key={group.license} group={group} search={q} />
              ))}
              {!hasResults && (
                <p className="text-center text-muted-foreground py-8">
                  No packages found matching "{search}"
                </p>
              )}
            </div>
          </>
        )}

        <footer className="mt-12 pt-6 border-t text-sm text-muted-foreground flex flex-wrap gap-4">
          <span>&copy; {new Date().getFullYear()} HCP CRM / hcpcrm.com</span>
          <Link href="/terms" className="underline hover:text-foreground">
            Terms of Service
          </Link>
          <Link href="/privacy" className="underline hover:text-foreground">
            Privacy Policy
          </Link>
        </footer>
      </div>
    </main>
  );
}
