'use client';
import { Field } from '@base-ui/react/field';
import { Select } from '@base-ui/react/select';
import * as React from 'react';

import { quality } from '@/constants';

interface QualitySelectorProps {
  value: number;
  onChange: (value: number) => void;
}

export function QualitySelector({ value, onChange }: QualitySelectorProps) {
  const selectedQuality = quality.find((q) => q.value === value) || quality[1];

  return (
    <Field.Root className="flex flex-col gap-1 w-full">
      <Field.Label className="cursor-default text-sm leading-5 font-medium text-gray-900 dark:text-gray-100">
        Video Quality
      </Field.Label>
      <Select.Root
        value={selectedQuality}
        onValueChange={(val) => val && onChange(val.value)}
        itemToStringValue={(item) => String(item.value)}
      >
        <Select.Trigger className="flex min-h-10 w-full items-start justify-between gap-3 rounded-md border border-gray-200 dark:border-gray-800 pr-3 pl-3.5 py-2 text-base bg-[canvas] text-gray-900 dark:text-gray-100 select-none hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-blue-800 data-[popup-open]:bg-gray-100 dark:data-[popup-open]:bg-gray-800 transition-colors">
          <Select.Value>
            {(item) => {
              const parts = item.label.split(' (');
              const name = parts[0];
              const detail = parts[1]?.replace(')', '') || '';
              return (
                <span className="flex flex-col items-start gap-0.5">
                  <span className="text-base leading-6 font-medium">{name}</span>
                  <span className="text-xs leading-4 text-gray-600 dark:text-gray-400">
                    {detail}
                  </span>
                </span>
              );
            }}
          </Select.Value>
          <Select.Icon className="flex items-center self-center text-gray-500">
            <ChevronUpDownIcon />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner className="outline-none select-none z-50" sideOffset={8}>
            <Select.Popup className="group min-w-[var(--anchor-width)] origin-[var(--transform-origin)] bg-clip-padding rounded-md bg-[canvas] text-gray-900 dark:text-gray-100 shadow-lg shadow-gray-200 dark:shadow-black/50 outline outline-1 outline-gray-200 dark:outline-gray-800 transition-[transform,scale,opacity] data-[ending-style]:scale-90 data-[ending-style]:opacity-0 data-[side=none]:min-w-[calc(var(--anchor-width)+1rem)] data-[side=none]:data-[ending-style]:transition-none data-[starting-style]:scale-90 data-[starting-style]:opacity-0 data-[side=none]:data-[starting-style]:scale-100 data-[side=none]:data-[starting-style]:opacity-100 data-[side=none]:data-[starting-style]:transition-none dark:bg-zinc-950">
              <Select.ScrollUpArrow className="top-0 z-[1] flex h-4 w-full cursor-default items-center justify-center rounded-md bg-[canvas] text-center text-xs before:absolute data-[side=none]:before:top-[-100%] before:left-0 before:h-full before:w-full before:content-['']" />
              <Select.List className="relative py-1 scroll-py-6 overflow-y-auto max-h-[var(--available-height)]">
                {quality.map((q) => (
                  <Select.Item
                    key={q.value}
                    value={q}
                    className="grid cursor-default grid-cols-[0.75rem_1fr] items-start gap-2 py-2.5 pr-4 pl-2.5 text-sm leading-4 outline-none select-none group-data-[side=none]:pr-12 group-data-[side=none]:text-base group-data-[side=none]:leading-5 pointer-coarse:py-2.5 pointer-coarse:text-[0.925rem] [@media(hover:hover)]:data-highlighted:relative [@media(hover:hover)]:[&[data-highlighted]]:z-0 [@media(hover:hover)]:[&[data-highlighted]]:text-gray-50 [@media(hover:hover)]:[&[data-highlighted]]:before:content-[''] [@media(hover:hover)]:[&[data-highlighted]]:before:absolute [@media(hover:hover)]:[&[data-highlighted]]:before:inset-y-0 [@media(hover:hover)]:[&[data-highlighted]]:before:inset-x-1 [@media(hover:hover)]:[&[data-highlighted]]:before:rounded-sm [@media(hover:hover)]:[&[data-highlighted]]:before:bg-gray-900 dark:[@media(hover:hover)]:[&[data-highlighted]]:before:bg-gray-100 dark:[@media(hover:hover)]:[&[data-highlighted]]:text-gray-900 [@media(hover:hover)]:[&[data-highlighted]]:before:z-[-1]"
                  >
                    <Select.ItemIndicator className="col-start-1 flex items-center self-start relative top-[0.4em]">
                      <CheckIcon className="size-3" />
                    </Select.ItemIndicator>
                    <Select.ItemText className="col-start-2 flex flex-col items-start gap-0.5">
                      {(() => {
                        const parts = q.label.split(' (');
                        const name = parts[0];
                        const detail = parts[1]?.replace(')', '') || '';
                        return (
                          <div className="flex justify-between items-center w-full">
                            <span className="text-base leading-6 font-medium">{name}</span>
                            <span className="text-xs leading-4 opacity-80">{detail}</span>
                          </div>
                        );
                      })()}
                    </Select.ItemText>
                  </Select.Item>
                ))}
              </Select.List>
              <Select.ScrollDownArrow className="bottom-0 z-1 flex h-4 w-full cursor-default items-center justify-center rounded-md bg-[canvas] text-center text-xs before:absolute before:left-0 before:h-full before:w-full before:content-[''] data-[side=none]:before:-bottom-full" />
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
    </Field.Root>
  );
}

function ChevronUpDownIcon(props: React.ComponentProps<'svg'>) {
  return (
    <svg
      width="8"
      height="12"
      viewBox="0 0 8 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      {...props}
    >
      <path d="M0.5 4.5L4 1.5L7.5 4.5" />
      <path d="M0.5 7.5L4 10.5L7.5 7.5" />
    </svg>
  );
}

function CheckIcon(props: React.ComponentProps<'svg'>) {
  return (
    <svg fill="currentColor" width="10" height="10" viewBox="0 0 10 10" {...props}>
      <path d="M9.1603 1.12218C9.50684 1.34873 9.60427 1.81354 9.37792 2.16038L5.13603 8.66012C5.01614 8.8438 4.82192 8.96576 4.60451 8.99384C4.3871 9.02194 4.1683 8.95335 4.00574 8.80615L1.24664 6.30769C0.939709 6.02975 0.916013 5.55541 1.19372 5.24822C1.47142 4.94102 1.94536 4.91731 2.2523 5.19524L4.36085 7.10461L8.12299 1.33999C8.34934 0.993152 8.81376 0.895638 9.1603 1.12218Z" />
    </svg>
  );
}
