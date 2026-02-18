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
      className={`p-8 border-2 border-blue-200 bg-blue-50/50 hover:bg-blue-50 transition-colors group relative overflow-hidden flex flex-col items-center justify-center gap-3 ${
        isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      }`}
      onClick={!isDisabled ? handleClick : undefined}
    >
      <AnimatePresence mode="wait">
        {showConfirmation ? (
          <motion.div
            key="check"
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0 }}
            className="text-green-500"
          >
            <Check size={24} strokeWidth={3} />
          </motion.div>
        ) : (
          <motion.div
            key="zap"
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0 }}
            className="text-blue-500"
          >
            <Zap size={24} fill="currentColor" className="text-blue-500" />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="font-semibold text-blue-600 text-lg">
        {isGenerating ? 'Generating...' : showConfirmation ? 'Done!' : 'Auto Zooms'}
      </div>
    </Card>
  );
}
