import { ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "~/lib/utils";

/** A styled native `<select>`. The class name sizes the wrapper; the select fills it. */
function NativeSelect({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <span
      data-slot="native-select"
      className={cn("relative inline-flex min-w-0 has-[select:disabled]:opacity-50", className)}
    >
      <select
        className="border-input bg-card focus-visible:border-ring focus-visible:ring-ring h-9 w-full min-w-0 cursor-pointer appearance-none truncate border pr-8 pl-3 font-mono text-sm transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed"
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2"
      />
    </span>
  );
}

export { NativeSelect };
