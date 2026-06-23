import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { PredictionService } from './prediction.service';

@Controller('prediccion')
export class PredictionController {
  constructor(private readonly predictionService: PredictionService) {}

  @Post('generate')
  @HttpCode(HttpStatus.OK)
  generateAllPredictions() {
    return this.predictionService.generateAllPredictions();
  }

  @Post('group/:group')
  predictGroup(@Param('group') group: string) {
    return this.predictionService.predictGroupStage(group.toUpperCase());
  }

  @Get('results')
  getPredictions(@Query('group') group?: string) {
    if (group) {
      return this.predictionService.getGroupPredictions(group.toUpperCase());
    }
    return this.predictionService.getAllPredictions();
  }

  @Get('knockout')
  getKnockoutPredictions() {
    return this.predictionService.getKnockoutBracket();
  }
}
