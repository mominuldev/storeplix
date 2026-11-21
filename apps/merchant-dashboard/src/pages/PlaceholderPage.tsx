import { Card, EmptyState } from '@storeplix/ui';
import { Construction } from 'lucide-react';
import { PageHeader } from '../layout/PageHeader';

export function PlaceholderPage({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <EmptyState icon={<Construction />} title={`${title} is coming soon`} description="This section is planned for a later phase." />
      </Card>
    </>
  );
}
