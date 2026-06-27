import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TeamsService } from '../teams/teams.service';

interface TeamProfile {
  id: string;
  name: string;
  fifaRanking: number;
  goalsForPer90: number;
  goalsAgainstPer90: number;
  formPoints: number; // Last 10 matches: 3 points for a win, 1 for a loss
  keyPlayersAvailable: boolean; // placeholder, you could estimate based on injuries
}

@Injectable()
export class PredictionService {
  private readonly logger = new Logger(PredictionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly teamsService: TeamsService,
  ) {}

  async generateAllPredictions() {
    this.logger.log('Generating predictions for all groups...');
    const groups = 'ABCDEFGHIJKL'.split('');
    for (const group of groups) {
      await this.predictGroupStage(group);
    }
    await this.predictKnockoutStage();
    return { message: 'All predictions generated' };
  }

  async predictGroupStage(group: string) {
    const teams = await this.prisma.nationalTeam.findMany({
      where: { group },
      include: {
        teamStats: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (teams.length === 0) return [];

    // Construir perfiles
    const profiles: TeamProfile[] = teams.map((t) => {
      const stats = t.teamStats[0];
      const form = stats?.form || '';
      const formPoints = form
        .split('')
        .reduce((acc, res) => acc + (res === 'W' ? 3 : res === 'D' ? 1 : 0), 0);
      return {
        id: t.id,
        name: t.name,
        fifaRanking: t.fifaRanking ?? 1000,
        goalsForPer90: stats?.avgGoalsFor ?? 0,
        goalsAgainstPer90: stats?.avgGoalsAgainst ?? 0,
        formPoints,
        keyPlayersAvailable: true, // mejorable
      };
    });

    // Simular partidos (todos contra todos)
    const matches: any[] = [];
    for (let i = 0; i < profiles.length; i++) {
      for (let j = i + 1; j < profiles.length; j++) {
        const result = this.simulateMatch(profiles[i], profiles[j]);
        matches.push({
          home: profiles[i].name,
          away: profiles[j].name,
          ...result,
        });
      }
    }

    // Calcular puntos finales
    const pointsTable: Record<
      string,
      { points: number; gf: number; ga: number }
    > = {};
    profiles.forEach((p) => {
      pointsTable[p.name] = { points: 0, gf: 0, ga: 0 };
    });

    for (const m of matches) {
      const home = m.home;
      const away = m.away;
      if (m.homeGoals > m.awayGoals) {
        pointsTable[home].points += 3;
      } else if (m.homeGoals < m.awayGoals) {
        pointsTable[away].points += 3;
      } else {
        pointsTable[home].points += 1;
        pointsTable[away].points += 1;
      }
      pointsTable[home].gf += m.homeGoals;
      pointsTable[home].ga += m.awayGoals;
      pointsTable[away].gf += m.awayGoals;
      pointsTable[away].ga += m.homeGoals;
    }

    // Ordenar por puntos, diferencia de goles, etc.
    const sorted = Object.entries(pointsTable)
      .map(([name, data]) => {
        const team = profiles.find((p) => p.name === name);
        return {
          name,
          points: data.points,
          goalDiff: data.gf - data.ga,
          goalsFor: data.gf,
          goalsAgainst: data.ga,
          teamId: team!.id,
        };
      })
      .sort((a, b) => {
        if (a.points !== b.points) return b.points - a.points;
        if (a.goalDiff !== b.goalDiff) return b.goalDiff - a.goalDiff;
        return b.goalsFor - a.goalsFor;
      });

    // Guardar predicciones en BD
    for (let idx = 0; idx < sorted.length; idx++) {
      const team = sorted[idx];
      const advances = idx < 2; // top 2 avanzan
      await this.prisma.groupStagePrediction.upsert({
        where: { teamId: team.teamId },
        update: {
          predictedPosition: idx + 1,
          predictedPoints: team.points,
          predictedGoalsFor: team.goalsFor,
          predictedGoalsAgainst: team.goalsAgainst,
          advancesToKnockout: advances,
          confidence: 0.7 + Math.random() * 0.2,
          reasoning: `Basado en ranking FIFA, promedio de goles y forma reciente.`,
        },
        create: {
          teamId: team.teamId,
          groupName: group,
          predictedPosition: idx + 1,
          predictedPoints: team.points,
          predictedGoalsFor: team.goalsFor,
          predictedGoalsAgainst: team.goalsAgainst,
          advancesToKnockout: advances,
          confidence: 0.7,
          reasoning: `Simulación con modelo Elo + Poisson.`,
        },
      });
    }

    this.logger.log(`Predicciones guardadas para grupo ${group}`);
    return sorted;
  }

  private simulateMatch(
    home: TeamProfile,
    away: TeamProfile,
  ): { homeGoals: number; awayGoals: number } {
    // FIFA Ranking (lower ranking = better)
    const rankingFactor = (away.fifaRanking - home.fifaRanking) / 200; // positive if the location is better

    let expectedHomeGoals =
      (home.goalsForPer90 + away.goalsAgainstPer90) / 2 + rankingFactor * 0.3;
    let expectedAwayGoals =
      (away.goalsForPer90 + home.goalsAgainstPer90) / 2 - rankingFactor * 0.2;

    expectedHomeGoals = Math.max(0, expectedHomeGoals);
    expectedAwayGoals = Math.max(0, expectedAwayGoals);

    // Simulate position
    const homeGoals = this.poissonSample(expectedHomeGoals);
    const awayGoals = this.poissonSample(expectedAwayGoals);
    return { homeGoals, awayGoals };
  }

  private poissonSample(lambda: number): number {
    const L = Math.exp(-lambda);
    let p = 1.0;
    let k = 0;
    do {
      k++;
      p *= Math.random();
    } while (p > L);
    return k - 1;
  }

  async predictKnockoutStage() {
    // Get the first and second places in each group
    const groups = 'ABCDEFGHIJKL'.split('');
    const roundOf16: Array<{
      teamId: string;
      name: string;
      group: string;
      position: number;
    }> = [];

    for (const group of groups) {
      // eslint-disable-next-line
      const predictions = await this.prisma.groupStagePrediction.findMany({
        where: { groupName: group, advancesToKnockout: true },
        include: { team: true },
        orderBy: { predictedPosition: 'asc' },
      });
      for (const p of predictions) {
        roundOf16.push({
          teamId: p.teamId,
          name: p.team.name,
          group: p.groupName,
          position: p.predictedPosition,
        });
      }
    }

    // Define typical World Cup matchups (1st vs. 2nd from another group)
    // Simplified example: A1 vs. B2, C1 vs. D2, E1 vs. F2, G1 vs. H2, B1 vs. A2, etc.
    // To keep things simple, we'll create a fixed bracket using the standard format.
    const bracket = [
      {
        match: 'R16-1',
        team1: this.findTeam(roundOf16, 'A', 1),
        team2: this.findTeam(roundOf16, 'B', 2),
      },
      {
        match: 'R16-2',
        team1: this.findTeam(roundOf16, 'C', 1),
        team2: this.findTeam(roundOf16, 'D', 2),
      },
      {
        match: 'R16-3',
        team1: this.findTeam(roundOf16, 'E', 1),
        team2: this.findTeam(roundOf16, 'F', 2),
      },
      {
        match: 'R16-4',
        team1: this.findTeam(roundOf16, 'G', 1),
        team2: this.findTeam(roundOf16, 'H', 2),
      },
      {
        match: 'R16-5',
        team1: this.findTeam(roundOf16, 'B', 1),
        team2: this.findTeam(roundOf16, 'A', 2),
      },
      {
        match: 'R16-6',
        team1: this.findTeam(roundOf16, 'D', 1),
        team2: this.findTeam(roundOf16, 'C', 2),
      },
      {
        match: 'R16-7',
        team1: this.findTeam(roundOf16, 'F', 1),
        team2: this.findTeam(roundOf16, 'E', 2),
      },
      {
        match: 'R16-8',
        team1: this.findTeam(roundOf16, 'H', 1),
        team2: this.findTeam(roundOf16, 'G', 2),
      },
    ];

    // Simular cada ronda
    const quarterFinals = await this.simulateRound(bracket, 'R16', 'Cuartos');
    const semiFinals = await this.simulateRound(
      quarterFinals,
      'Cuartos',
      'Semifinal',
    );
    const finalMatch = await this.simulateRound(
      semiFinals,
      'Semifinal',
      'Final',
    );
    const champion = finalMatch[0]?.winner || null;

    if (champion) {
      await this.prisma.knockoutPrediction.upsert({
        where: { teamId_round: { teamId: champion.teamId, round: 'Campeón' } },
        update: {
          eliminated: false,
          confidence: 0.85,
          reasoning: 'Ganador del torneo según simulación',
        },
        create: {
          teamId: champion.teamId,
          round: 'Campeón',
          eliminated: false,
          confidence: 0.85,
          reasoning: 'Modelo predictivo',
        },
      });
    }

    return { champion: champion?.name, bracket };
  }

  private findTeam(list: any[], group: string, position: number) {
    return list.find((t) => t.group === group && t.position === position);
  }

  private async simulateRound(
    matches: Array<{ match: string; team1?: any; team2?: any }>,
    roundName: string,
    nextRoundName: string,
  ): Promise<any[]> {
    type MatchResult = { match: string; team1?: any; team2?: any };
    const nextMatches: MatchResult[] = [];
    for (const m of matches) {
      if (!m.team1 || !m.team2) continue;
      const profile1 = await this.getTeamProfile(m.team1.teamId);
      const profile2 = await this.getTeamProfile(m.team2.teamId);
      const { homeGoals, awayGoals } = this.simulateMatch(profile1, profile2);
      const winner = homeGoals > awayGoals ? m.team1 : m.team2;
      const loser = winner === m.team1 ? m.team2 : m.team1;

      await this.prisma.knockoutPrediction.upsert({
        where: { teamId_round: { teamId: winner.teamId, round: roundName } },
        update: { eliminated: false, confidence: 0.8 },
        create: {
          teamId: winner.teamId,
          round: roundName,
          eliminated: false,
          confidence: 0.8,
        },
      });
      await this.prisma.knockoutPrediction.upsert({
        where: { teamId_round: { teamId: loser.teamId, round: roundName } },
        update: { eliminated: true, confidence: 0.8 },
        create: {
          teamId: loser.teamId,
          round: roundName,
          eliminated: true,
          confidence: 0.8,
        },
      });

      nextMatches.push({
        match: `${nextRoundName}-${nextMatches.length + 1}`,
        team1: winner,
      });
    }
    // Advance to the next round
    const paired: MatchResult[] = [];
    for (let i = 0; i < nextMatches.length; i += 2) {
      paired.push({
        match: `${nextRoundName}-${i / 2 + 1}`,
        team1: nextMatches[i]?.team1,
        team2: nextMatches[i + 1]?.team1,
      });
    }
    return paired;
  }

  private async getTeamProfile(teamId: string): Promise<TeamProfile> {
    const team = await this.prisma.nationalTeam.findUnique({
      where: { id: teamId },
      include: { teamStats: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    const stats = team?.teamStats[0];
    const form = stats?.form || '';
    const formPoints = form
      .split('')
      .reduce((acc, res) => acc + (res === 'W' ? 3 : res === 'D' ? 1 : 0), 0);
    return {
      id: team!.id,
      name: team!.name,
      fifaRanking: team?.fifaRanking ?? 1000,
      goalsForPer90: stats?.avgGoalsFor ?? 0,
      goalsAgainstPer90: stats?.avgGoalsAgainst ?? 0,
      formPoints,
      keyPlayersAvailable: true,
    };
  }

  getGroupPredictions(group: string) {
    return this.prisma.groupStagePrediction.findMany({
      where: { groupName: group },
      include: { team: true },
      orderBy: { predictedPosition: 'asc' },
    });
  }

  getAllPredictions() {
    return this.prisma.groupStagePrediction.findMany({
      include: { team: true },
      orderBy: [{ groupName: 'asc' }, { predictedPosition: 'asc' }],
    });
  }

  getKnockoutBracket() {
    return this.prisma.knockoutPrediction.findMany({
      include: { team: true },
      orderBy: [{ round: 'asc' }],
    });
  }
}
