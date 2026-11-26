import * as Collapsible from '@radix-ui/react-collapsible';
import {ChevronRight} from 'lucide-react';
import type {ReactNode} from 'react';

export function Disclosure({label, children, open, onOpenChange}: {
  label: ReactNode; children: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  return <Collapsible.Root className="disclosure" open={open} onOpenChange={onOpenChange}>
    <Collapsible.Trigger className="disclosure-trigger">
      <span>{label}</span>
      <span className="disclosure-indicator" aria-hidden="true"><ChevronRight size={22} strokeWidth={2.5}/></span>
    </Collapsible.Trigger>
    <Collapsible.Content className="disclosure-content">{children}</Collapsible.Content>
  </Collapsible.Root>;
}
