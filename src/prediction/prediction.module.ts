import { Module } from '@nestjs/common';
import { PredictionService } from './prediction.service';
import { TeamsModule } from '../teams/teams.module';
import { PredictionController } from './prediction.controller';

@Module({
  imports: [TeamsModule],
  controllers: [PredictionController],
  providers: [PredictionService],
  exports: [PredictionService],
})
export class PredictionModule {}
