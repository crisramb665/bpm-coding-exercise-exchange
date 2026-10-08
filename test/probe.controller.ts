import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsString, Matches } from 'class-validator';
import { Roles } from '../src/common/auth/roles.guard';
import { BusinessError } from '../src/common/errors/business-error';

class AmountDto {
  @IsString()
  @Matches(/^\d{1,20}(\.\d{1,8})?$/)
  amount!: string;
}

// Rutas que existen solo en las pruebas: ejercitan los guards, el pipe y el filtro de errores
// antes de que existan los endpoints reales. Se registran con createApp({ controllers: [ProbeController] }).
@Controller('probe')
export class ProbeController {
  @Get('any')
  any(): { ok: true } {
    return { ok: true }; // sin @Roles: basta con estar autenticado
  }

  @Get('user')
  @Roles('USER')
  userOnly(): { ok: true } {
    return { ok: true };
  }

  @Get('compliance')
  @Roles('COMPLIANCE')
  complianceOnly(): { ok: true } {
    return { ok: true };
  }

  @Post('amount')
  amount(@Body() body: AmountDto): { amount: string } {
    return { amount: body.amount };
  }

  @Get('business-error')
  businessError(): never {
    throw new BusinessError('QUOTE_EXPIRED', 422, 'La cotización venció', { quote_id: 'q-1' });
  }
}
