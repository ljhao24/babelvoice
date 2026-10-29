import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// Direction A sizes (13px, 28px). `segmented` is the Mac segmented control
// item: the pressed one is raised on the control fill; pair it with
// <ToggleGroup variant="segmented">, which draws the recessed track.
const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-lg text-body font-normal whitespace-nowrap transition-all outline-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 aria-pressed:bg-muted data-[state=on]:bg-muted dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "border border-input bg-transparent hover:bg-muted",
        segmented:
          "rounded-[5px] bg-transparent hover:bg-transparent aria-pressed:bg-control aria-pressed:text-control-foreground aria-pressed:shadow-xs",
      },
      size: {
        default:
          "h-7 min-w-7 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        sm: "h-6 min-w-6 rounded-[min(var(--radius-md),8px)] px-2.5 text-callout has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-8 min-w-8 px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
