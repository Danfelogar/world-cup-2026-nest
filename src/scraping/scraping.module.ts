import { Module, forwardRef } from '@nestjs/common';
import { ScrapingService } from './scraping.service';
import { ScrapingController } from './scraping.controller';
import { TeamsModule } from '../teams/teams.module';

@Module({
  imports: [forwardRef(() => TeamsModule)],
  controllers: [ScrapingController],
  providers: [ScrapingService],
  exports: [ScrapingService],
})
export class ScrapingModule {}
