import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { KYC_COUNTRY_OPTIONS, KYC_NATIONALITY_OPTIONS } from '../../common/kyc/country-options';
import { ProfileOptionsDto } from './dto/profile-options.dto';

/**
 * The lists a client profile accepts for country and nationality.
 *
 * PUBLIC, for the same reason `GET /currencies` is: the answer is the same for
 * everybody and holds no client data, and the screen that needs it most — the
 * registration form — has no session by definition.
 *
 * It exists so there is ONE list. The profile refuses a country the list does
 * not hold (`common/profile/client-profile.ts`), so a form offering its own copy
 * would sooner or later offer a choice the server then refuses — a sign-up that
 * cannot be completed, with nothing on screen saying why. The KYC form receives
 * the same lists inside its configuration; the support desk's edit reads them
 * from here.
 */
@ApiTags('profile')
@Controller('profile')
export class ProfileOptionsController {
  @Get('options')
  @ApiOperation({ summary: 'The countries and nationalities a client profile accepts' })
  @ApiOkResponse({ type: ProfileOptionsDto })
  options(): ProfileOptionsDto {
    return { countries: [...KYC_COUNTRY_OPTIONS], nationalities: [...KYC_NATIONALITY_OPTIONS] };
  }
}
