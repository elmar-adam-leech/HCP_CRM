import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Building2, Upload, Search, X, Loader2, Palette } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";

interface ContractorData {
  logoUrl?: string | null;
  brandColor?: string | null;
}

const DEFAULT_BRAND_COLOR = "#3b82f6";
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function CompanyBrandingCard() {
  const { data: currentUser } = useCurrentUser();
  const { toast } = useToast();

  const isAdmin = currentUser?.user?.role === "admin" || currentUser?.user?.role === "super_admin";

  const { data: contractor } = useQuery<ContractorData>({
    queryKey: ["/api/contractor"],
    enabled: isAdmin,
  });

  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [uploadFileName, setUploadFileName] = useState<string | null>(null);
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [brandColorDraft, setBrandColorDraft] = useState<string>(DEFAULT_BRAND_COLOR);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Hydrate the color draft when the contractor record loads or changes.
  useEffect(() => {
    setBrandColorDraft(contractor?.brandColor || DEFAULT_BRAND_COLOR);
  }, [contractor?.brandColor]);

  const currentLogo = uploadPreview ?? contractor?.logoUrl ?? null;

  const saveMutation = useMutation({
    mutationFn: (logoUrl: string) =>
      apiRequest("PATCH", "/api/contractor/logo", { logoUrl }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contractor"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/contractors"] });
      setUploadPreview(null);
      setUploadFileName(null);
      toast({ title: "Logo saved", description: "Your company logo has been updated." });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast({ title: "Failed to save logo", description: message, variant: "destructive" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/contractor/logo"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contractor"] });
      queryClient.invalidateQueries({ queryKey: ["/api/user/contractors"] });
      setUploadPreview(null);
      setUploadFileName(null);
      setCandidates([]);
      toast({ title: "Logo removed", description: "Your company logo has been removed." });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast({ title: "Failed to remove logo", description: message, variant: "destructive" });
    },
  });

  const brandColorMutation = useMutation({
    mutationFn: (brandColor: string | null) =>
      apiRequest("PATCH", "/api/contractor/brand-color", { brandColor }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contractor"] });
      toast({ title: "Brand color saved", description: "Your booking page will now use this color." });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast({ title: "Failed to save brand color", description: message, variant: "destructive" });
    },
  });

  const scanMutation = useMutation({
    mutationFn: (url: string) => {
      setCandidates([]);
      return apiRequest("POST", "/api/contractor/logo/scan", { websiteUrl: url });
    },
    onSuccess: async (res: Response) => {
      const data: { candidates?: string[] } = await res.json();
      if (!data.candidates || data.candidates.length === 0) {
        toast({ title: "No logos found", description: "We couldn't find any logos on that website.", variant: "destructive" });
      } else {
        setCandidates(data.candidates);
      }
    },
    onError: (err: unknown) => {
      setCandidates([]);
      const message = err instanceof Error ? err.message : "Could not fetch website.";
      toast({ title: "Scan failed", description: message, variant: "destructive" });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 500 * 1024) {
      toast({ title: "File too large", description: "Please select an image under 500 KB.", variant: "destructive" });
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      setUploadPreview(ev.target?.result as string);
      setUploadFileName(file.name);
      setCandidates([]);
    };
    reader.readAsDataURL(file);
  };

  const handleSaveUpload = () => {
    if (uploadPreview) {
      saveMutation.mutate(uploadPreview);
    }
  };

  const handleScanSelect = (url: string) => {
    saveMutation.mutate(url);
    setCandidates([]);
    setWebsiteUrl("");
  };

  const handleCancelUpload = () => {
    setUploadPreview(null);
    setUploadFileName(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  if (!isAdmin) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="h-5 w-5" />
          Company Branding
        </CardTitle>
        <CardDescription>
          Add your company logo to personalise the sidebar. Supports file upload or scanning from your website.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center gap-4">
          <div className="h-20 w-20 rounded-md border bg-muted flex items-center justify-center shrink-0 overflow-hidden">
            {currentLogo ? (
              <img src={currentLogo} alt="Company logo" className="h-full w-full object-contain" />
            ) : (
              <Building2 className="h-8 w-8 text-muted-foreground" />
            )}
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">Current logo</p>
            {contractor?.logoUrl || uploadPreview ? (
              <p className="text-xs text-muted-foreground">
                {uploadPreview ? "Preview — not yet saved" : "Saved"}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">No logo set — using default.</p>
            )}
            {(contractor?.logoUrl && !uploadPreview) && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive px-0 h-auto text-xs"
                onClick={() => removeMutation.mutate()}
                disabled={removeMutation.isPending}
              >
                {removeMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <X className="h-3 w-3 mr-1" />}
                Remove logo
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Upload className="h-4 w-4" />
            Upload logo file
          </Label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
          >
            Choose file
          </Button>
          {uploadFileName && (
            <p className="text-xs text-muted-foreground">{uploadFileName}</p>
          )}
          {uploadPreview && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleSaveUpload}
                disabled={saveMutation.isPending}
              >
                {saveMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                Save logo
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCancelUpload}
                disabled={saveMutation.isPending}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Search className="h-4 w-4" />
            Scan from website
          </Label>
          <div className="flex gap-2">
            <Input
              type="url"
              placeholder="https://yourcompany.com"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              className="flex-1"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => scanMutation.mutate(websiteUrl)}
              disabled={!websiteUrl || scanMutation.isPending}
            >
              {scanMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Find Logo
            </Button>
          </div>

          {candidates.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Select a logo to save it:</p>
              <div className="flex gap-3 flex-wrap">
                {candidates.map((url) => (
                  <button
                    key={url}
                    className="h-16 w-16 rounded-md border bg-muted flex items-center justify-center overflow-hidden hover-elevate active-elevate-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => handleScanSelect(url)}
                    disabled={saveMutation.isPending}
                    title={url}
                    type="button"
                  >
                    <img
                      src={url}
                      alt="Candidate logo"
                      className="h-full w-full object-contain"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Palette className="h-4 w-4" />
            Brand color
          </Label>
          <p className="text-xs text-muted-foreground">
            Sets the accent color on your public booking page (primary button, focus rings, etc.).
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="color"
              value={HEX_RE.test(brandColorDraft) ? brandColorDraft : DEFAULT_BRAND_COLOR}
              onChange={(e) => setBrandColorDraft(e.target.value)}
              className="h-9 w-12 rounded-md border bg-background cursor-pointer p-1"
              data-testid="input-brand-color-picker"
              aria-label="Brand color picker"
            />
            <Input
              value={brandColorDraft}
              onChange={(e) => setBrandColorDraft(e.target.value)}
              placeholder="#3b82f6"
              className="w-32 font-mono"
              data-testid="input-brand-color-hex"
            />
            <Button
              size="sm"
              onClick={() => brandColorMutation.mutate(brandColorDraft.toLowerCase())}
              disabled={
                brandColorMutation.isPending
                || !HEX_RE.test(brandColorDraft)
                || brandColorDraft.toLowerCase() === (contractor?.brandColor || "").toLowerCase()
              }
              data-testid="button-save-brand-color"
            >
              {brandColorMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Save color
            </Button>
            {contractor?.brandColor && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => brandColorMutation.mutate(null)}
                disabled={brandColorMutation.isPending}
                data-testid="button-reset-brand-color"
              >
                <X className="h-3 w-3 mr-1" />
                Reset to default
              </Button>
            )}
          </div>
          {!HEX_RE.test(brandColorDraft) && (
            <p className="text-xs text-destructive">Enter a 6-digit hex color (e.g. #3b82f6).</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
