import { Check, Zap } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';

import { Card } from '@/components/ui/card';
import type { Project } from '@/types';

export function AutoZoomButton({
  generateZoomsFromClicks,
  isGenerating,
  project,
}: {
  generateZoomsFromClicks: () => void;
  isGenerating: boolean;
  project: Project | null;
}) {
  const [showConfirmation, setShowConfirmation] = useState(false);

  const handleClick = () => {
    generateZoomsFromClicks();
    setShowConfirmation(true);
    setTimeout(() => setShowConfirmation(false), 2000);
  };

  const isDisabled = isGenerating || !project;

  return (
    <Card
      className={`p-8 border-2 border-brand/30 bg-[radial-gradient(circle_at_center,transparent_20%,var(--color-brand-dark)_150%)] hover:border-brand/60 hover:bg-[radial-gradient(circle_at_center,transparent_10%,var(--color-brand-dark)_120%)] transition-all duration-300 group relative overflow-hidden flex flex-col items-center justify-center gap-3 shadow-[0_0_15px_rgba(16,185,129,0.1)] hover:shadow-[0_0_25px_rgba(16,185,129,0.2)] ${
        isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      }`}
      onClick={!isDisabled ? handleClick : undefined}
    >
      <div className="absolute inset-0 bg-gradient-to-t from-brand-light/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
      <AnimatePresence mode="wait">
        {showConfirmation ? (
          <motion.div
            key="check"
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0 }}
            className="text-brand-light relative z-10"
          >
            <Check size={24} strokeWidth={3} />
          </motion.div>
        ) : (
          <motion.div
            key="zap"
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0 }}
            className="text-brand relative z-10 group-hover:text-brand-light transition-colors duration-300"
          >
            <Zap
              size={24}
              fill="currentColor"
              className="drop-shadow-[0_0_8px_rgba(52,211,153,0.5)]"
            />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="font-semibold text-brand-light text-lg relative z-10 tracking-wide">
        {isGenerating ? 'Generating...' : showConfirmation ? 'Done!' : 'Auto Zooms'}
      </div>
    </Card>
  );
}
