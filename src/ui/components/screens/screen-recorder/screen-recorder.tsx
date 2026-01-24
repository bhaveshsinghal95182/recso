import { Button } from '@/components/ui/button';

export function ScreenRecorderBody() {
  return (
    <div className="flex items-center justify-center h-screen ">
      <Button variant="default" size="lg" className="cursor-pointer">
        Record
      </Button>
    </div>
  );
}
